import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mistralAdapter } from "../../src/adapters/mistral";
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
      id: "chatcmpl-mistral",
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
  originalApiKey = config.mistral.apiKey;
  config.mistral.apiKey = "ms_test_key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.mistral.apiKey = originalApiKey;
});

describe("Mistral Adapter", () => {
  it("should handle basic request", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from Mistral!"),
    ) as unknown as typeof fetch;

    const response = await mistralAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content[0].type).toBe("text");
    expect((response.content[0] as any).text).toBe("Hello from Mistral!");
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

    const stream = await mistralAdapter.sendStream!(baseReq);
    expect(stream).toBeDefined();
  });
});
