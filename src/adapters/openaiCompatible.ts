import { rateLimiter, retryAfterFromError } from "../rateLimiter";
import { AnthropicSSEWriter } from "../streaming/anthropicSSE";
import type {
  AnthropicMessage,
  AnthropicResponse,
  ContentBlock,
  NormalizedRequest,
  TierName,
  ToolDefinition,
} from "../types";

export class ProviderError extends Error {
  headers?: Headers;
  status: number;

  constructor(message: string, status: number, headers?: Headers) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.headers = headers;
  }
}

export async function readProviderError(
  res: Response,
  provider: string,
  model: string,
): Promise<string> {
  let raw = "";
  try {
    raw = await res.clone().text();
  } catch {
    raw = "";
  }

  const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
  const looksLikeHtml =
    contentType.includes("text/html") || /<\s*!doctype\s+html|<\s*html\b/i.test(raw);
  if (looksLikeHtml) {
    const title = raw.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i)?.[1]?.trim();
    const target = raw
      .match(/data-translate=["']unable_to_access["'][^>]*>[^<]*<\/[^>]+>\s*([^<]+)/i)?.[1]
      ?.trim();
    const detail = [
      title,
      target ? `unable to access ${target}` : "upstream returned an HTML block page",
    ]
      .filter(Boolean)
      .join("; ");
    return `${provider} request was blocked upstream for model "${model}" (HTTP ${res.status}): ${detail}`;
  }

  let detail = "";
  try {
    const parsed = JSON.parse(raw);
    detail = parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? raw;
  } catch {
    detail = raw || "unknown upstream error";
  }

  const normalizedDetail = String(detail).trim();
  if (!normalizedDetail) {
    return `${provider} model "${model}" is not available or rejected by the provider (HTTP ${res.status}).`;
  }

  const lower = normalizedDetail.toLowerCase();
  if (
    lower.includes("model not found") ||
    lower.includes("not found") ||
    lower.includes("unknown model") ||
    lower.includes("model unavailable") ||
    lower.includes("does not exist") ||
    lower.includes("invalid model")
  ) {
    return `${provider} model "${model}" is not available in your account or provider settings: ${normalizedDetail}`;
  }

  return `${provider} request failed for model "${model}": ${normalizedDetail}`;
}

export function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export const OPENAI_COMPATIBLE_CONTEXT_LIMIT = 128_000;

export function fitsOpenAICompatibleContext(
  estimatedTokens: number,
  maxContext = OPENAI_COMPATIBLE_CONTEXT_LIMIT,
): boolean {
  return estimatedTokens <= maxContext;
}

export function sanitizeOpenAICompatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOpenAICompatibleSchema(item));
  }

  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, innerValue] of Object.entries(value as Record<string, unknown>)) {
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
          "pattern",
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

      cleaned[key] = sanitizeOpenAICompatibleSchema(innerValue);
    }

    if (cleaned.properties && typeof cleaned.properties === "object") {
      const properties = Object.fromEntries(
        Object.entries(cleaned.properties as Record<string, unknown>).map(([name, schema]) => [
          name,
          sanitizeOpenAICompatibleSchema(schema),
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

export function anthropicToolsToOpenAI(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: sanitizeOpenAICompatibleSchema(t.input_schema),
    },
  }));
}

export function openAIToolsToAnthropic(tools: any[]): ToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => ({
    name: t.function?.name ?? t.name ?? "",
    description: t.function?.description ?? t.description,
    input_schema: t.function?.parameters ?? t.parameters ?? { type: "object", properties: {} },
  }));
}

export function openAIRequestToNormalized(body: any): NormalizedRequest {
  let systemPrompt = "";
  const messages: AnthropicMessage[] = [];

  for (const m of body.messages ?? []) {
    if (m.role === "system") {
      systemPrompt = systemPrompt ? `${systemPrompt}\n${m.content}` : (m.content ?? "");
    } else if (m.role === "user") {
      messages.push({
        role: "user",
        content: m.content ?? "",
      });
    } else if (m.role === "assistant") {
      const content: ContentBlock[] = [];
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: tc.id ?? crypto.randomUUID(),
          name: tc.function?.name ?? "",
          input: safeJsonParse(tc.function?.arguments ?? "{}"),
        });
      }
      messages.push({
        role: "assistant",
        content: content.length === 1 && content[0].type === "text" ? content[0].text : content,
      });
    } else if (m.role === "tool") {
      // OpenAI tool response maps to Anthropic user turn with tool_result block
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content: m.content ?? "",
          },
        ],
      });
    }
  }

  return {
    systemPrompt,
    messages,
    tools: openAIToolsToAnthropic(body.tools ?? []),
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature,
    stream: body.stream ?? false,
  };
}

export function anthropicResponseToOpenAI(
  response: AnthropicResponse,
  requestedModel = "model-router-auto",
) {
  let content = "";
  const toolCalls: any[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const finishReason =
    response.stop_reason === "tool_use"
      ? "tool_calls"
      : response.stop_reason === "max_tokens"
        ? "length"
        : "stop";

  return {
    id: `chatcmpl-${response.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

export function buildOpenAIPayload(req: NormalizedRequest, model: string) {
  const messages: any[] = [];
  if (req.systemPrompt) {
    messages.push({ role: "system", content: req.systemPrompt });
  }

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    const toolResults = m.content.filter((b) => b.type === "tool_result") as any[];
    const toolUses = m.content.filter((b) => b.type === "tool_use") as any[];
    const textBlocks = m.content.filter((b) => b.type === "text") as any[];
    const textParts = textBlocks.map((b) => b.text).join("\n");

    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
      });
    }

    if (toolUses.length > 0) {
      messages.push({
        role: "assistant",
        content: textParts || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        })),
      });
    } else if (textParts) {
      messages.push({ role: m.role, content: textParts });
    }
  }

  return {
    model,
    messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    stream: req.stream,
    tools: req.tools?.length ? anthropicToolsToOpenAI(req.tools) : undefined,
  };
}

export function openAIResponseToAnthropic(data: any, model: string): AnthropicResponse {
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content: ContentBlock[] = [];

  const textCandidates = [message.content, message.reasoning].filter((v) => typeof v === "string");
  const mainText = textCandidates.join("\n").trim();

  if (mainText) {
    content.push({ type: "text", text: mainText });
  }
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? crypto.randomUUID(),
      name: call.function?.name ?? "",
      input: safeJsonParse(call.function?.arguments ?? "{}"),
    });
  }

  const stopReason =
    choice?.finish_reason === "tool_calls"
      ? "tool_use"
      : choice?.finish_reason === "length"
        ? "max_tokens"
        : "end_turn";

  return {
    id: data.id ?? crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export function createOpenAICompatibleStream(
  url: string,
  headers: Record<string, string>,
  payload: object,
  model: string,
  signal?: AbortSignal,
  tier?: TierName,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const writer = new AnthropicSSEWriter(controller);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ ...payload, stream: true }),
          signal,
        });
        if (!res.ok) {
          const message = await readProviderError(
            res,
            tier ??
              (model.includes("/") ? "OpenAI-compatible provider" : "OpenAI-compatible provider"),
            model,
          );
          const err = new ProviderError(message, res.status, res.headers);
          const retryMs = retryAfterFromError(err);
          if (retryMs !== undefined && tier) {
            rateLimiter.markUnavailable(tier, retryMs);
          }
          writer.error(message);
          return;
        }
        await streamOpenAIToAnthropic(res, model, writer);
      } catch (err: any) {
        if (signal?.aborted) return;
        const retryMs = retryAfterFromError(err);
        if (retryMs !== undefined && tier) {
          rateLimiter.markUnavailable(tier, retryMs);
        }
        writer.error(err.message ?? String(err));
      }
    },
  });
}

export async function streamOpenAIToAnthropic(
  upstream: Response,
  model: string,
  writer: AnthropicSSEWriter,
) {
  if (!upstream.body) {
    writer.error("upstream returned no body");
    return;
  }

  writer.start(model);

  let textBlockOpen = false;
  let activeToolIndex: number | null = null;
  const toolBlocks = new Map<number, { id: string; name: string }>();
  let finishReason: string | null = null;
  let outputTokens: number | undefined;

  const reader = upstream.body.getReader();
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
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
      if (!delta) continue;

      if (delta.content) {
        if (activeToolIndex !== null) {
          writer.stopBlock();
          activeToolIndex = null;
        }
        if (!textBlockOpen) {
          writer.startText();
          textBlockOpen = true;
        }
        writer.textDelta(delta.content);
      }

      for (const call of delta.tool_calls ?? []) {
        const idx: number = call.index ?? 0;
        if (!toolBlocks.has(idx)) {
          if (textBlockOpen) {
            writer.stopBlock();
            textBlockOpen = false;
          }
          if (activeToolIndex !== null && activeToolIndex !== idx) {
            writer.stopBlock();
          }
          const id = call.id ?? crypto.randomUUID();
          const name = call.function?.name ?? "";
          writer.startTool(id, name);
          toolBlocks.set(idx, { id, name });
          activeToolIndex = idx;
        }
        const args = call.function?.arguments;
        if (args) writer.toolInputDelta(args);
      }
    }
  }

  const stopReason =
    finishReason === "tool_calls" || toolBlocks.size > 0
      ? "tool_use"
      : finishReason === "length"
        ? "max_tokens"
        : "end_turn";
  writer.end(stopReason, 0, outputTokens);
}
