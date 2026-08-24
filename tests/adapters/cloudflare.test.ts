import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cloudflareAdapter } from "../../src/adapters/cloudflare";
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
      id: "chatcmpl-cf",
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
let originalApiToken: string;
let originalAccountId: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalApiToken = config.cloudflare.apiToken;
  originalAccountId = config.cloudflare.accountId;
  config.cloudflare.apiToken = "cf_token";
  config.cloudflare.accountId = "cf_account";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.cloudflare.apiToken = originalApiToken;
  config.cloudflare.accountId = originalAccountId;
});

describe("Cloudflare Adapter", () => {
  it("should handle basic request", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from Cloudflare!"),
    ) as unknown as typeof fetch;

    const response = await cloudflareAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content[0].type).toBe("text");
    expect((response.content[0] as any).text).toBe("Hello from Cloudflare!");
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

    const stream = await cloudflareAdapter.sendStream!(baseReq);
    expect(stream).toBeDefined();
  });
});
