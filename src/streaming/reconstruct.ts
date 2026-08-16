import type { AnthropicResponse, ContentBlock } from "../types";

/**
 * Wraps a stream of Anthropic-format SSE bytes: forwards every chunk to
 * the client untouched, while separately parsing the same bytes to
 * rebuild the full AnthropicResponse. Calls `onComplete` once, when
 * `message_stop` is seen — never on error (a stream that errors out
 * produces no cache entry, same as a failed non-streaming call).
 *
 * This only depends on the shape of our own SSE writer (anthropicSSE.ts),
 * not on any provider specifics, so it works unchanged for every tier.
 */
export function reconstructingStream(
  source: ReadableStream<Uint8Array>,
  onComplete: (response: AnthropicResponse) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";

  let messageId = crypto.randomUUID();
  let model = "";
  let stopReason: AnthropicResponse["stop_reason"] = "end_turn";
  const usage = { input_tokens: 0, output_tokens: 0 };

  const blockType = new Map<number, "text" | "tool_use">();
  const textByIndex = new Map<number, string>();
  const toolByIndex = new Map<number, { id: string; name: string; jsonParts: string[] }>();

  function handleEvent(event: string, data: any) {
    switch (event) {
      case "message_start":
        messageId = data.message?.id ?? messageId;
        model = data.message?.model ?? model;
        if (typeof data.message?.usage?.input_tokens === "number") {
          usage.input_tokens = data.message.usage.input_tokens;
        }
        break;

      case "content_block_start":
        blockType.set(data.index, data.content_block?.type);
        if (data.content_block?.type === "tool_use") {
          toolByIndex.set(data.index, {
            id: data.content_block.id,
            name: data.content_block.name,
            jsonParts: [],
          });
        } else {
          textByIndex.set(data.index, "");
        }
        break;

      case "content_block_delta":
        if (data.delta?.type === "text_delta") {
          textByIndex.set(
            data.index,
            (textByIndex.get(data.index) ?? "") + (data.delta.text ?? ""),
          );
        } else if (data.delta?.type === "input_json_delta") {
          toolByIndex.get(data.index)?.jsonParts.push(data.delta.partial_json ?? "");
        }
        break;

      case "message_delta":
        if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        if (typeof data.usage?.output_tokens === "number")
          usage.output_tokens = data.usage.output_tokens;
        break;

      case "message_stop": {
        const content: ContentBlock[] = [];
        const indices = [...blockType.keys()].sort((a, b) => a - b);
        for (const idx of indices) {
          if (blockType.get(idx) === "text") {
            content.push({ type: "text", text: textByIndex.get(idx) ?? "" });
          } else {
            const t = toolByIndex.get(idx);
            if (!t) continue;
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(t.jsonParts.join(""));
            } catch {
              // partial/invalid JSON — cache with empty input rather than crash
            }
            content.push({ type: "tool_use", id: t.id, name: t.name, input });
          }
        }
        onComplete({
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason: stopReason,
          usage,
        });
        break;
      }
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const raw of events) {
        let eventName = "";
        let dataLine = "";
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("event:")) eventName = trimmed.slice(6).trim();
          else if (trimmed.startsWith("data:")) dataLine = trimmed.slice(5).trim();
        }
        if (!eventName || !dataLine) continue;
        try {
          handleEvent(eventName, JSON.parse(dataLine));
        } catch {
          // malformed SSE frame — skip it, don't kill the pass-through
        }
      }
    },
  });

  return source.pipeThrough(transform);
}
