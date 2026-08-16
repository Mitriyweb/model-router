import { config } from "../config";
import { AnthropicSSEWriter } from "../streaming/anthropicSSE";
import type { AnthropicResponse, ContentBlock, NormalizedRequest, ProviderAdapter } from "../types";
import { anthropicToolsToOpenAI, safeJsonParse } from "./openaiCompatible";

function buildCoherePayload(req: NormalizedRequest, model: string, stream = false) {
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
        content: textParts || undefined,
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
    tools: req.tools.length ? anthropicToolsToOpenAI(req.tools) : undefined,
    stream,
  };
}

function cohereResponseToAnthropic(data: any, model: string): AnthropicResponse {
  const message = data.message ?? {};
  const content: ContentBlock[] = [];

  if (Array.isArray(message.content)) {
    for (const c of message.content) {
      if (c.text) content.push({ type: "text", text: c.text });
    }
  } else if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }

  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? crypto.randomUUID(),
      name: call.function?.name ?? "",
      input: safeJsonParse(call.function?.arguments ?? "{}"),
    });
  }

  const finishReason = data.finish_reason;
  const stopReason =
    finishReason === "TOOL_CALL" || (message.tool_calls && message.tool_calls.length > 0)
      ? "tool_use"
      : finishReason === "MAX_TOKENS"
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
      input_tokens: data.usage?.tokens?.input_tokens ?? 0,
      output_tokens: data.usage?.tokens?.output_tokens ?? 0,
    },
  };
}

export const cohereAdapter: ProviderAdapter = {
  tier: "cohere",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return estimatedTokens <= config.cohere.limits.tpm;
  },

  async send(req: NormalizedRequest) {
    const payload = buildCoherePayload(req, config.cohere.model, false);
    const url = `${config.cohere.baseUrl}/chat`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.cohere.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Cohere error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return cohereResponseToAnthropic(data, config.cohere.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildCoherePayload(req, config.cohere.model, true);
    const url = `${config.cohere.baseUrl}/chat`;

    return new ReadableStream({
      async start(controller) {
        const writer = new AnthropicSSEWriter(controller);
        writer.start(config.cohere.model);

        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.cohere.apiKey}`,
            },
            body: JSON.stringify(payload),
          });

          if (!res.ok || !res.body) {
            writer.error(`Cohere error ${res.status}: ${await res.text().catch(() => "")}`);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let textBlockOpen = false;
          let sawTool = false;
          let inputTokens = 0;
          let outputTokens = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const dataStr = trimmed.slice(5).trim();
              if (!dataStr || dataStr === "[DONE]") continue;

              let event: any;
              try {
                event = JSON.parse(dataStr);
              } catch {
                continue;
              }

              const type = event.type;
              if (type === "content-delta") {
                const text = event.delta?.message?.content?.text;
                if (text) {
                  if (!textBlockOpen) {
                    writer.startText();
                    textBlockOpen = true;
                  }
                  writer.textDelta(text);
                }
              } else if (type === "tool-call-start") {
                if (textBlockOpen) {
                  writer.stopBlock();
                  textBlockOpen = false;
                }
                const tc = event.delta?.message?.tool_calls;
                const id = tc?.id ?? crypto.randomUUID();
                const name = tc?.function?.name ?? "";
                writer.startTool(id, name);
                sawTool = true;
              } else if (type === "tool-call-delta") {
                const args = event.delta?.message?.tool_calls?.function?.arguments;
                if (args) writer.toolInputDelta(args);
              } else if (type === "tool-call-end") {
                writer.stopBlock();
              } else if (type === "message-end") {
                const usage = event.delta?.usage?.tokens;
                if (usage) {
                  inputTokens = usage.input_tokens ?? inputTokens;
                  outputTokens = usage.output_tokens ?? outputTokens;
                }
              }
            }
          }

          writer.end(sawTool ? "tool_use" : "end_turn", inputTokens, outputTokens);
        } catch (err: any) {
          writer.error(err.message ?? String(err));
        }
      },
    });
  },
};
