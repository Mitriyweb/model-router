import type { AnthropicResponse } from "../types";

type AnthropicResponseLike = AnthropicResponse;
type Controller = ReadableStreamDefaultController<Uint8Array>;

export class AnthropicSSEWriter {
  static fromResponse(response: AnthropicResponseLike, controller: Controller) {
    const writer = new AnthropicSSEWriter(controller);
    writer.start(response.model, response.id, response.usage.input_tokens);
    for (const block of response.content) {
      if (block.type === "text") {
        writer.startText();
        writer.textDelta(block.text);
        writer.stopBlock();
      } else if (block.type === "tool_use") {
        writer.startTool(block.id, block.name, block.thoughtSignature ?? block.thought_signature);
        writer.toolInputDelta(JSON.stringify(block.input));
        writer.stopBlock();
      }
    }
    writer.end(
      (response.stop_reason as "end_turn" | "max_tokens" | "tool_use") ?? "end_turn",
      response.usage.input_tokens,
      response.usage.output_tokens,
    );
  }

  private controller: Controller;
  private encoder = new TextEncoder();
  private blockIndex = -1;
  private openBlock = false;
  private outputTokens = 0;

  constructor(controller: Controller) {
    this.controller = controller;
  }

  private emit(event: string, data: unknown) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      this.controller.enqueue(this.encoder.encode(chunk));
    } catch {
      // Controller might be closed if client disconnected
    }
  }

  start(model: string, id: string = crypto.randomUUID(), inputTokens = 0) {
    this.emit("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
  }

  startText() {
    this.stopBlock();
    this.blockIndex++;
    this.openBlock = true;
    this.emit("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: { type: "text", text: "" },
    });
    return this.blockIndex;
  }

  textDelta(text: string) {
    this.outputTokens += Math.ceil(text.length / 4);
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: "text_delta", text },
    });
  }

  startTool(id: string, name: string, thoughtSignature?: string) {
    this.stopBlock();
    this.blockIndex++;
    this.openBlock = true;
    this.emit("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: {
        type: "tool_use",
        id,
        name,
        input: {},
        ...(thoughtSignature ? { thoughtSignature } : {}),
      },
    });
    return this.blockIndex;
  }

  toolInputDelta(partialJson: string) {
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: "input_json_delta", partial_json: partialJson },
    });
  }

  stopBlock() {
    if (!this.openBlock) return;
    this.emit("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.openBlock = false;
  }

  end(stopReason: "end_turn" | "max_tokens" | "tool_use", _inputTokens = 0, outputTokens?: number) {
    this.stopBlock();
    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens ?? this.outputTokens },
    });
    this.emit("message_stop", { type: "message_stop" });
    try {
      this.controller.close();
    } catch {
      // already closed
    }
  }

  error(message: string) {
    this.emit("error", { type: "error", error: { type: "api_error", message } });
    try {
      this.controller.close();
    } catch {
      // already closed
    }
  }
}
