import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { geminiAdapter } from "../../src/adapters/gemini";
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
      candidates: [
        {
          content: {
            parts: [{ text: content }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let originalFetch: typeof globalThis.fetch;
let originalApiKey: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalApiKey = config.gemini.apiKey;
  config.gemini.apiKey = "gemini_test_key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.gemini.apiKey = originalApiKey;
});

describe("Gemini Adapter", () => {
  it("should handle basic request", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from Gemini!"),
    ) as unknown as typeof fetch;

    const response = await geminiAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content[0].type).toBe("text");
    expect((response.content[0] as any).text).toBe("Hello from Gemini!");
  });

  it("should handle streaming requests", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: "Hello" }],
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const stream = await geminiAdapter.sendStream!(baseReq);
    expect(stream).toBeDefined();
  });
});
