import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { geminiAdapter } from "../../src/adapters/gemini";
import { config } from "../../src/config";
import { ProviderError } from "../../src/errors";
import { rateLimiter } from "../../src/rateLimiter";
import { reconstructingStream } from "../../src/streaming/reconstruct";
import type { AnthropicResponse, NormalizedRequest } from "../../src/types";

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

afterEach(async () => {
  globalThis.fetch = originalFetch;
  config.gemini.apiKey = originalApiKey;
  await rateLimiter.reset();
});

describe("Gemini Adapter", () => {
  it("should handle basic request", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from Gemini!"),
    ) as unknown as typeof fetch;

    const response = await geminiAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content[0]?.type).toBe("text");
    expect((response.content[0] as any).text).toBe("Hello from Gemini!");
  });

  it("sends the API key in a header instead of the URL", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;

    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      calledUrl = String(input);
      calledInit = init;
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await geminiAdapter.send(baseReq);

    expect(calledUrl).not.toContain("key=");
    expect((calledInit?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "gemini_test_key",
    );
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
    expect(response.content[0]?.type).toBe("tool_use");
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

  it("maps MAX_TOKENS and missing usage metadata", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "Truncated" }] },
                finishReason: "MAX_TOKENS",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const response = await geminiAdapter.send(baseReq);

    expect(response.stop_reason).toBe("max_tokens");
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("builds systemInstruction and generationConfig from the normalized request", async () => {
    let body: Record<string, any> = {};
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await geminiAdapter.send({ ...baseReq, maxTokens: 256, temperature: 0.4 });

    expect(body.systemInstruction).toEqual({ parts: [{ text: baseReq.systemPrompt }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 256, temperature: 0.4 });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello!" }] }]);
  });

  it("always accepts a request regardless of the estimated token count", () => {
    expect(geminiAdapter.canHandle(baseReq, 0)).toBe(true);
    expect(geminiAdapter.canHandle(baseReq, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("maps upstream errors to ProviderError with the Gemini model name", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: "model is unavailable" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    let error: unknown;
    try {
      await geminiAdapter.send(baseReq);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(404);
    expect((error as ProviderError).message).toContain(config.gemini.model);
    expect((error as ProviderError).message).toContain("model is unavailable");
  });

  it("reconstructs streamed text and usage into a complete response", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ content: { parts: [{ text: "Hello" }] } }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    let completed: AnthropicResponse | undefined;
    const raw = geminiAdapter.sendStream!(baseReq);
    await new Response(
      reconstructingStream(raw, (response) => {
        completed = response;
      }),
    ).text();

    expect(completed).toBeDefined();
    expect(completed?.content[0]).toEqual({ type: "text", text: "Hello" });
    // Streams emit message_start before usage is known, so input_tokens stays 0;
    // output_tokens comes from the final message_delta.
    expect(completed?.usage).toEqual({ input_tokens: 0, output_tokens: 5 });
  });
});
