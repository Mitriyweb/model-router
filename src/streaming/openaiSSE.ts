/**
 * Converts Anthropic-formatted SSE bytes into OpenAI-formatted SSE bytes
 * for /v1/chat/completions streaming clients (ZeroClaw, Aider, Cline, OpenAI SDK, Chat UIs).
 *
 * Anthropic SSE events:
 *   message_start -> content_block_start -> content_block_delta -> content_block_stop -> message_delta -> message_stop
 *
 * OpenAI SSE chunks:
 *   data: {"id":"...","object":"chat.completion.chunk","model":"...","choices":[{"index":0,"delta":{"content":"..."},"finish_reason":null}]}
 *   data: [DONE]
 */

export function anthropicStreamToOpenAI(
  source: ReadableStream<Uint8Array>,
  fallbackModel = "model-router-auto",
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  let messageId = `chatcmpl-${crypto.randomUUID()}`;
  let model = fallbackModel;
  let activeToolIndex: number | null = null;

  function emitOpenAIChunk(
    controller: TransformStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ) {
    const chunk = {
      id: messageId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function handleEvent(
    event: string,
    data: any,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    switch (event) {
      case "message_start":
        messageId = data.message?.id ? `chatcmpl-${data.message.id}` : messageId;
        model = data.message?.model ?? model;
        // Emit initial role
        emitOpenAIChunk(controller, { role: "assistant", content: "" }, null);
        break;

      case "content_block_start":
        if (data.content_block?.type === "tool_use") {
          activeToolIndex = data.index ?? 0;
          emitOpenAIChunk(
            controller,
            {
              tool_calls: [
                {
                  index: activeToolIndex,
                  id: data.content_block.id,
                  type: "function",
                  function: {
                    name: data.content_block.name,
                    arguments: "",
                  },
                },
              ],
            },
            null,
          );
        }
        break;

      case "content_block_delta":
        if (data.delta?.type === "text_delta" && data.delta.text) {
          emitOpenAIChunk(controller, { content: data.delta.text }, null);
        } else if (data.delta?.type === "input_json_delta" && data.delta.partial_json) {
          emitOpenAIChunk(
            controller,
            {
              tool_calls: [
                {
                  index: activeToolIndex ?? 0,
                  function: {
                    arguments: data.delta.partial_json,
                  },
                },
              ],
            },
            null,
          );
        }
        break;

      case "message_delta": {
        const stopReason = data.delta?.stop_reason;
        const finishReason =
          stopReason === "tool_use"
            ? "tool_calls"
            : stopReason === "max_tokens"
              ? "length"
              : stopReason === "end_turn"
                ? "stop"
                : null;
        emitOpenAIChunk(controller, {}, finishReason);
        break;
      }

      case "message_stop":
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        break;
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
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
          handleEvent(eventName, JSON.parse(dataLine), controller);
        } catch {
          // malformed frame — continue
        }
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });

  return source.pipeThrough(transform);
}
