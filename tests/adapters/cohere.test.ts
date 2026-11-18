import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cohereAdapter } from "../../src/adapters/cohere";
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

afterEach(async () => {
  globalThis.fetch = originalFetch;
  config.cohere.apiKey = originalApiKey;
  await rateLimiter.reset();
});

describe("Cohere Adapter", () => {
  it("should handle basic request", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from Cohere!"),
    ) as unknown as typeof fetch;

    const response = await cohereAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content[0]?.type).toBe("text");
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

  it("maps system prompts, tools and tool results into the Cohere payload", async () => {
    let body: Record<string, any> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await cohereAdapter.send({
      ...baseReq,
      maxTokens: 128,
      temperature: 0.2,
      tools: [
        {
          name: "search",
          description: "Search the web",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking it up" },
            { type: "tool_use", id: "call-1", name: "search", input: { q: "cats" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "Meow" }],
        },
      ],
    });

    expect(body.model).toBe(config.cohere.model);
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toEqual({ role: "system", content: baseReq.systemPrompt });
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "Looking it up",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "search", arguments: '{"q":"cats"}' } },
      ],
    });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "call-1", content: "Meow" });
    expect(body.tools[0].function.name).toBe("search");
  });

  it("maps tool calls, finish reasons and usage into an Anthropic response", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "cohere-1",
          finish_reason: "TOOL_CALL",
          message: {
            content: [{ type: "text", text: "Here" }],
            tool_calls: [
              {
                id: "call-2",
                function: { name: "search", arguments: '{"q":"cats"}' },
              },
            ],
          },
          usage: { tokens: { input_tokens: 12, output_tokens: 7 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const response = await cohereAdapter.send(baseReq);

    expect(response.id).toBe("cohere-1");
    expect(response.stop_reason).toBe("tool_use");
    expect(response.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
    expect(response.content[0]).toEqual({ type: "text", text: "Here" });
    expect(response.content[1]).toMatchObject({
      type: "tool_use",
      id: "call-2",
      name: "search",
      input: { q: "cats" },
    });
  });

  it("reconstructs a streamed Cohere response with usage", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of [
            { type: "content-delta", delta: { message: { content: { text: "Hello" } } } },
            {
              type: "message-end",
              delta: { usage: { tokens: { input_tokens: 10, output_tokens: 5 } } },
            },
          ]) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    let completed: AnthropicResponse | undefined;
    const raw = reconstructingStream(cohereAdapter.sendStream!(baseReq), (response) => {
      completed = response;
    });
    const sse = await new Response(raw).text();

    expect(sse).toContain("event: message_start");
    expect(sse).toContain("Hello");
    expect(sse).toContain("event: message_stop");
    expect(completed).toBeDefined();
    expect(completed?.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(completed?.usage.output_tokens).toBe(5);
  });

  it("maps 429 responses to ProviderError with retry metadata", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "rate limit reached" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": "2" },
      })) as unknown as typeof fetch;

    let error: unknown;
    try {
      await cohereAdapter.send(baseReq);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(429);
    expect((error as ProviderError).message).toContain("rate limit reached");
  });

  it("uses the router context limit for canHandle", () => {
    const original = config.routerMaxContextTokens;
    try {
      config.routerMaxContextTokens = 100;
      expect(cohereAdapter.canHandle(baseReq, 100)).toBe(true);
      expect(cohereAdapter.canHandle(baseReq, 101)).toBe(false);
    } finally {
      config.routerMaxContextTokens = original;
    }
  });
});
