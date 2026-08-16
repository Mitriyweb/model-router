import { describe, expect, it } from "bun:test";
import { AnthropicSSEWriter } from "../src/streaming/anthropicSSE";
import { reconstructingStream } from "../src/streaming/reconstruct";
import type { AnthropicResponse } from "../src/types";

describe("streaming and reconstruction", () => {
  it("reconstructs full Anthropic response from SSE stream", async () => {
    let capturedResponse: AnthropicResponse | undefined;

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const writer = new AnthropicSSEWriter(controller);
        writer.start("test-model", "msg_test_id", 15);
        writer.startText();
        writer.textDelta("Hello ");
        writer.textDelta("world!");
        writer.stopBlock();

        writer.startTool("tool_1", "get_weather");
        writer.toolInputDelta('{"location":');
        writer.toolInputDelta('"Kyiv"}');
        writer.stopBlock();

        writer.end("tool_use", 15, 25);
      },
    });

    const reconstructed = reconstructingStream(source, (resp) => {
      capturedResponse = resp;
    });

    // Consume the stream
    const reader = reconstructed.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const resp = capturedResponse as unknown as AnthropicResponse;
    expect(resp).toBeDefined();
    expect(resp.id).toBe("msg_test_id");
    expect(resp.model).toBe("test-model");
    expect(resp.stop_reason).toBe("tool_use");
    expect(resp.usage.input_tokens).toBe(15);
    expect(resp.usage.output_tokens).toBe(25);
    expect(resp.content).toEqual([
      { type: "text", text: "Hello world!" },
      { type: "tool_use", id: "tool_1", name: "get_weather", input: { location: "Kyiv" } },
    ]);
  });
});
