import { config } from "../config";
import { rateLimiter, retryAfterFromError } from "../rateLimiter";
import { AnthropicSSEWriter } from "../streaming/anthropicSSE";
import type { AnthropicResponse, ContentBlock, NormalizedRequest, ProviderAdapter } from "../types";
import { ProviderError, readProviderError } from "./openaiCompatible";

function buildToolIdToNameMap(req: NormalizedRequest): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of req.messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") {
          map.set(b.id, b.name);
        }
      }
    }
  }
  return map;
}

export function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGeminiSchema(item));
  }

  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);

    for (const [key, innerValue] of entries) {
      if (
        [
          "$schema",
          "$defs",
          "definitions",
          "additionalProperties",
          "propertyNames",
          "const",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "default",
          "examples",
          "deprecated",
          "readOnly",
          "writeOnly",
          "nullable",
          "title",
          "description",
          "format",
          "contentEncoding",
          "contentMediaType",
          "anyOf",
          "allOf",
          "oneOf",
          "any_of",
          "all_of",
          "one_of",
          "not",
        ].includes(key)
      ) {
        continue;
      }

      cleaned[key] = sanitizeGeminiSchema(innerValue);
    }

    if (cleaned.properties && typeof cleaned.properties === "object") {
      const properties = Object.fromEntries(
        Object.entries(cleaned.properties as Record<string, unknown>).map(([name, schema]) => [
          name,
          sanitizeGeminiSchema(schema),
        ]),
      );
      cleaned.properties = properties;

      if (Array.isArray(cleaned.required)) {
        const valid = new Set(Object.keys(properties));
        cleaned.required = cleaned.required.filter(
          (item) => typeof item === "string" && valid.has(item),
        );
      }
    }

    return cleaned;
  }

  return value;
}

function buildGeminiPayload(req: NormalizedRequest) {
  const toolIdToName = buildToolIdToNameMap(req);

  const contents = req.messages
    .map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
      }
      const parts: any[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push({ text: b.text });
        if (b.type === "tool_use") {
          parts.push({ functionCall: { name: b.name, args: b.input } });
        }
        if (b.type === "tool_result") {
          // Gemini requires the function name, not the tool_use_id UUID
          const functionName = toolIdToName.get(b.tool_use_id) ?? b.tool_use_id;
          parts.push({
            functionResponse: {
              name: functionName,
              response: {
                content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
              },
            },
          });
        }
      }
      return { role: m.role === "assistant" ? "model" : "user", parts };
    })
    .filter((c) => c.parts.length > 0);

  const tools = req.tools.length
    ? [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            parameters: sanitizeGeminiSchema(t.input_schema),
          })),
        },
      ]
    : undefined;

  return {
    contents,
    systemInstruction: req.systemPrompt ? { parts: [{ text: req.systemPrompt }] } : undefined,
    tools,
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      temperature: req.temperature,
    },
  };
}

function geminiResponseToAnthropic(data: any): AnthropicResponse {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: ContentBlock[] = [];

  for (const p of parts) {
    if (p.text) content.push({ type: "text", text: p.text });
    if (p.functionCall) {
      content.push({
        type: "tool_use",
        id: crypto.randomUUID(),
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
    }
  }

  const stopReason =
    candidate?.finishReason === "MAX_TOKENS"
      ? "max_tokens"
      : content.some((c) => c.type === "tool_use")
        ? "tool_use"
        : "end_turn";

  return {
    id: crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: config.gemini.model,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

export const geminiAdapter: ProviderAdapter = {
  tier: "gemini",

  canHandle() {
    return true;
  },

  sendStream(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const payload = buildGeminiPayload(req);
    const url = `${config.gemini.baseUrl}/models/${config.gemini.model}:streamGenerateContent?alt=sse&key=${config.gemini.apiKey}`;
    const signal = opts?.signal ?? req.signal;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const writer = new AnthropicSSEWriter(controller);
        writer.start(config.gemini.model);

        let textBlockOpen = false;
        let inputTokens = 0;
        let outputTokens = 0;
        let sawFunctionCall = false;

        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          });
          if (!res.ok || !res.body) {
            const rawText = await res.text().catch(() => "");
            const errMsg = await readProviderError(res, "Gemini", config.gemini.model).catch(
              () => `Gemini ${res.status}: ${rawText}`,
            );
            const err = new ProviderError(errMsg, res.status, res.headers);
            const retryMs = retryAfterFromError(err);
            if (retryMs !== undefined) {
              rateLimiter.markUnavailable("gemini", retryMs);
            }
            writer.error(errMsg);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payloadStr = trimmed.slice(5).trim();
              if (!payloadStr) continue;

              let chunk: any;
              try {
                chunk = JSON.parse(payloadStr);
              } catch {
                continue;
              }

              const parts = chunk.candidates?.[0]?.content?.parts ?? [];
              for (const p of parts) {
                if (p.text) {
                  if (!textBlockOpen) {
                    writer.startText();
                    textBlockOpen = true;
                  }
                  writer.textDelta(p.text);
                }
                if (p.functionCall) {
                  if (textBlockOpen) {
                    writer.stopBlock();
                    textBlockOpen = false;
                  }
                  writer.startTool(crypto.randomUUID(), p.functionCall.name);
                  writer.toolInputDelta(JSON.stringify(p.functionCall.args ?? {}));
                  writer.stopBlock();
                  sawFunctionCall = true;
                }
              }

              if (chunk.usageMetadata) {
                inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
                outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
              }
            }
          }

          writer.end(sawFunctionCall ? "tool_use" : "end_turn", inputTokens, outputTokens);
        } catch (err: any) {
          const retryMs = retryAfterFromError(err);
          if (retryMs !== undefined) {
            rateLimiter.markUnavailable("gemini", retryMs);
          }
          writer.error(err.message ?? String(err));
        }
      },
    });
  },

  async send(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const payload = buildGeminiPayload(req);
    const url = `${config.gemini.baseUrl}/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
    const signal = opts?.signal ?? req.signal;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const msg = await readProviderError(res, "Gemini", config.gemini.model);
      throw new ProviderError(msg, res.status, res.headers);
    }
    const data = await res.json();
    return geminiResponseToAnthropic(data);
  },
};
