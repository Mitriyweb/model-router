import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ProviderError } from "../../src/adapters/openaiCompatible";
import {
  OPENCODE_CONTEXT_WINDOW,
  OPENCODE_MAX_OUTPUT_TOKENS,
  opencodeAdapter,
} from "../../src/adapters/opencode";
import { config } from "../../src/config";
import type { NormalizedRequest } from "../../src/types";

const baseReq: NormalizedRequest = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [],
  stream: false,
};

function makeOkResponse(content = "Hi from OpenCode!", reasoning?: string) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-opencode-123",
      object: "chat.completion",
      created: 1700000000,
      model: "ling-3.0-flash-fin-free",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let originalFetch: typeof globalThis.fetch;
let originalApiKey: string;
let originalBaseUrl: string;
let originalModel: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalApiKey = config.opencode.apiKey;
  originalBaseUrl = config.opencode.baseUrl;
  originalModel = config.opencode.model;

  config.opencode.apiKey = "opencode_test_secret_key";
  config.opencode.baseUrl = "https://opencode.ai/zen/v1";
  config.opencode.model = "ling-3.0-flash-fin-free";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.opencode.apiKey = originalApiKey;
  config.opencode.baseUrl = originalBaseUrl;
  config.opencode.model = originalModel;
});

describe("OpenCode Zen Adapter", () => {
  it("Test 1 — identity: tier should be opencode", () => {
    expect(opencodeAdapter.tier).toBe("opencode");
  });

  it("Test 2 — model: default model should be ling-3.0-flash-fin-free", () => {
    expect(config.opencode.model).toBe("ling-3.0-flash-fin-free");
  });

  it("Test 3 — endpoint: sends POST to https://opencode.ai/zen/v1/chat/completions", async () => {
    let requestedUrl = "";
    let requestedMethod = "";
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = url.toString();
      requestedMethod = init?.method ?? "";
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await opencodeAdapter.send(baseReq);
    expect(requestedUrl).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(requestedMethod).toBe("POST");
  });

  it("Test 4 — authentication: sends Bearer token in header and not in URL", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = new Headers(init?.headers);
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await opencodeAdapter.send(baseReq);
    expect(capturedUrl).not.toContain("opencode_test_secret_key");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer opencode_test_secret_key");
    expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
  });

  it("Test 5 — request payload: formats OpenAI-compatible body", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await opencodeAdapter.send(baseReq);
    expect(capturedBody.model).toBe("ling-3.0-flash-fin-free");
    expect(capturedBody.stream).toBe(false);
    expect(capturedBody.messages).toHaveLength(2); // system + user
    expect(capturedBody.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(capturedBody.messages[1]).toEqual({ role: "user", content: "Hello!" });
  });

  it("Test 6 — response conversion: converts OpenAI response to Anthropic format", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from OpenCode Zen!"),
    ) as unknown as typeof fetch;

    const res = await opencodeAdapter.send(baseReq);
    expect(res.id).toBe("chatcmpl-opencode-123");
    expect(res.role).toBe("assistant");
    expect(res.model).toBe("ling-3.0-flash-fin-free");
    expect(res.stop_reason).toBe("end_turn");
    expect(res.content[0]).toEqual({ type: "text", text: "Hello from OpenCode Zen!" });
    expect(res.usage).toEqual({ input_tokens: 15, output_tokens: 8 });
  });

  it("Test 7 — reasoning: preserves reasoning_content in non-streaming response", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Final Answer", "Step 1: Thinking deeply about the problem..."),
    ) as unknown as typeof fetch;

    const res = await opencodeAdapter.send(baseReq);
    expect(res.content[0].type).toBe("text");
    const textContent = (res.content[0] as { type: "text"; text: string }).text;
    expect(textContent).toContain("Step 1: Thinking deeply about the problem...");
    expect(textContent).toContain("Final Answer");
  });

  it("Test 8 — reasoning streaming: streams reasoning and content deltas correctly", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { reasoning_content: "Thinking..." } }],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: "Here is the answer." } }],
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

    const rawStream = opencodeAdapter.sendStream!(baseReq);
    const reader = rawStream.getReader();
    const decoder = new TextDecoder();
    let emittedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      emittedText += decoder.decode(value);
    }

    expect(emittedText).toContain("Thinking...");
    expect(emittedText).toContain("Here is the answer.");
  });

  it("Test 9 — usage in streaming: handles usage fields in stream events", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: "Hello stream" } }],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ finish_reason: "stop" }],
                usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
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

    const rawStream = opencodeAdapter.sendStream!(baseReq);
    const reader = rawStream.getReader();
    const decoder = new TextDecoder();
    let emittedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      emittedText += decoder.decode(value);
    }

    expect(emittedText).toContain('"output_tokens":4');
  });

  it("Test 10 — tool calling: passes OpenAI-style tool definitions and parses tool_calls", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tools",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc123",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"location":"New York"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const toolReq: NormalizedRequest = {
      ...baseReq,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          input_schema: { type: "object", properties: { location: { type: "string" } } },
        },
      ],
    };

    const res = await opencodeAdapter.send(toolReq);
    expect(capturedBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: { type: "object", properties: { location: { type: "string" } } },
        },
      },
    ]);
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content[0]).toEqual({
      type: "tool_use",
      id: "call_abc123",
      name: "get_weather",
      input: { location: "New York" },
    });
  });

  it("Test 11 — error handling: throws ProviderError for HTTP 400, 401, 429, 500", async () => {
    const errorStatuses = [400, 401, 429, 500];
    for (const status of errorStatuses) {
      globalThis.fetch = mock(
        async () =>
          new Response(JSON.stringify({ error: { message: `OpenCode error ${status}` } }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      ) as unknown as typeof fetch;

      await expect(opencodeAdapter.send(baseReq)).rejects.toThrow(ProviderError);
    }
  });

  it("Test 12 — abort signal: passes AbortSignal to fetch call", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await opencodeAdapter.send(baseReq, { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("Test 13 — context capability: fits 262,144 tokens subject to router limits", () => {
    expect(OPENCODE_CONTEXT_WINDOW).toBe(262_144);
    expect(opencodeAdapter.canHandle(baseReq, 100_000)).toBe(true);
    expect(opencodeAdapter.canHandle(baseReq, 300_000)).toBe(false);
  });

  it("Test 14 — max output: caps max_tokens at 32,768 when request exceeds capacity", async () => {
    expect(OPENCODE_MAX_OUTPUT_TOKENS).toBe(32_768);

    let capturedBody: any;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return makeOkResponse();
    }) as unknown as typeof fetch;

    // Boundary check: 32768
    await opencodeAdapter.send({ ...baseReq, maxTokens: 32_768 });
    expect(capturedBody.max_tokens).toBe(32_768);

    // Above boundary check: 40000 -> capped at 32768
    await opencodeAdapter.send({ ...baseReq, maxTokens: 40_000 });
    expect(capturedBody.max_tokens).toBe(32_768);

    // Below boundary check: 4096 -> preserved at 4096
    await opencodeAdapter.send({ ...baseReq, maxTokens: 4_096 });
    expect(capturedBody.max_tokens).toBe(4_096);
  });
});
