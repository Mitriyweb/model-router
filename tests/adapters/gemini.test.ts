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

  it("should propagate thoughtSignature in non-streaming responses", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "get_current_weather",
                  args: { location: "Seattle, WA" },
                  thoughtSignature: "sig_abc123_crypto_hash",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 8,
      },
    };

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const response = await geminiAdapter.send(baseReq);
    expect(response.content[0].type).toBe("tool_use");
    const toolBlock = response.content[0] as any;
    expect(toolBlock.name).toBe("get_current_weather");
    expect(toolBlock.thoughtSignature).toBe("sig_abc123_crypto_hash");
    expect(toolBlock.thought_signature).toBe("sig_abc123_crypto_hash");
  });

  it("should propagate thoughtSignature in streaming responses", async () => {
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
                      parts: [
                        {
                          functionCall: {
                            name: "get_current_weather",
                            args: { location: "Seattle, WA" },
                            thoughtSignature: "sig_stream_456",
                          },
                        },
                      ],
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
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    expect(text).toContain('"type":"content_block_start"');
    expect(text).toContain('"thoughtSignature":"sig_stream_456"');
  });

  it("should format tool_use block with thought_signature into functionCall payload", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return makeOkResponse("Done");
    }) as unknown as typeof fetch;

    const reqWithToolUse: NormalizedRequest = {
      systemPrompt: "",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_123",
              name: "calculator",
              input: { expr: "2+2" },
              thought_signature: "sig_history_789",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_123",
              content: "4",
            },
          ],
        },
      ],
      tools: [],
      stream: false,
    };

    await geminiAdapter.send(reqWithToolUse);

    expect(capturedBody).toBeDefined();
    const modelPart = capturedBody.contents[0].parts[0];
    expect(modelPart.functionCall).toBeDefined();
    expect(modelPart.functionCall.name).toBe("calculator");
    expect(modelPart.functionCall.thoughtSignature).toBe("sig_history_789");
  });
});
