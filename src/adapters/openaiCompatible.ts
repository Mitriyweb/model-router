import { AnthropicSSEWriter } from "../streaming/anthropicSSE";
import type { AnthropicResponse, ContentBlock, NormalizedRequest, ToolDefinition } from "../types";

export function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function anthropicToolsToOpenAI(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema,
    },
  }));
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

    // Tool results become role: "tool" messages
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
      });
    }

    // If there were tool uses in an assistant message
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
    tools: req.tools.length ? anthropicToolsToOpenAI(req.tools) : undefined,
  };
}

export function openAIResponseToAnthropic(data: any, model: string): AnthropicResponse {
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content: ContentBlock[] = [];

  if (message.content) {
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
          writer.error(`upstream ${res.status}: ${await res.text()}`);
          return;
        }
        await streamOpenAIToAnthropic(res, model, writer);
      } catch (err: any) {
        if (signal?.aborted) return;
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
