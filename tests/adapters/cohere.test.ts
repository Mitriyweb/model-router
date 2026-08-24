import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cohereAdapter } from "../../src/adapters/cohere";
import { config } from "../../src/config";
import type { NormalizedRequest } from "../../src/types";

const baseReq: NormalizedRequest = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [],
  stream: false,
};

function makeOkResponse(content = "Hi there!") {
  return new Response(
    JSON.stringify({
      message: {
        content: [{ type: "text", text: content }],
      },
      usage: {
        tokens: {
          input_tokens: 10,
          output_tokens: 5,
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let originalFetch: typeof globalThis.fetch;
let originalApiKey: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalApiKey = config.cohere.apiKey;
  config.cohere.apiKey = "co_test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.cohere.apiKey = originalApiKey;
});

describe("Cohere Adapter", () => {
  it("should handle basic request", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from Cohere!"),
    ) as unknown as typeof fetch;

    const response = await cohereAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content[0].type).toBe("text");
    expect((response.content[0] as any).text).toBe("Hello from Cohere!");
  });

  it("should handle streaming requests", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: "content-delta",
                delta: { message: { content: { text: "Hello" } } },
              })}\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: "message-end",
              })}\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const stream = await cohereAdapter.sendStream!(baseReq);
    expect(stream).toBeDefined();
  });
});
