import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cerebrasAdapter } from "../../src/adapters/cerebras";
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
      id: "chatcmpl-cerebras",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let originalFetch: typeof globalThis.fetch;
let originalApiKey: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalApiKey = config.cerebras.apiKey;
  config.cerebras.apiKey = "csk_test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.cerebras.apiKey = originalApiKey;
});

describe("Cerebras Adapter", () => {
  it("should handle basic request", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from Cerebras!"),
    ) as unknown as typeof fetch;

    const response = await cerebrasAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content[0].type).toBe("text");
    expect((response.content[0] as any).text).toBe("Hello from Cerebras!");
  });

  it("should handle streaming requests", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: "Hello" } }],
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const stream = await cerebrasAdapter.sendStream!(baseReq);
    expect(stream).toBeDefined();
  });
});
