import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { huggingfaceAdapter } from "../../src/adapters/huggingface";
import { config } from "../../src/config";
import { rateLimiter } from "../../src/rateLimiter";
import { routeRequest } from "../../src/router";
import { TierName } from "../../src/types";
import type { NormalizedRequest } from "../../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseReq: NormalizedRequest = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [],
  stream: false,
};

function makeOkResponse(content = "Hi there!") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-hf-test",
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

function makeToolResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-hf-tool",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
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
}

function make429Response() {
  return new Response(
    JSON.stringify({ error: { message: "Rate limit exceeded. Retry in 30s." } }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "retry-after": "30",
      },
    },
  );
}

function makeSseStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let originalApiKey: string;
let originalModel: string;
let originalProvider: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalApiKey = config.huggingface.apiKey;
  originalModel = config.huggingface.model;
  originalProvider = config.huggingface.provider;

  // Defaults for most tests
  config.huggingface.apiKey = "hf_test_key";
  config.huggingface.model = "meta-llama/Llama-3.3-70B-Instruct";
  config.huggingface.provider = "";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.huggingface.apiKey = originalApiKey;
  config.huggingface.model = originalModel;
  config.huggingface.provider = originalProvider;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Hugging Face Adapter — canHandle", () => {
  it("returns false when HF_MODEL is not configured", () => {
    config.huggingface.model = "";
    expect(huggingfaceAdapter.canHandle(baseReq, 100)).toBe(false);
  });

  it("returns true when model is set and tokens fit", () => {
    expect(huggingfaceAdapter.canHandle(baseReq, 100)).toBe(true);
  });

  it("returns false when tokens exceed routerMaxContextTokens", () => {
    const huge = config.routerMaxContextTokens + 1;
    expect(huggingfaceAdapter.canHandle(baseReq, huge)).toBe(false);
  });
});

describe("Hugging Face Adapter — authentication", () => {
  it("skips (router hasCredentials = false) when HF_API_KEY is missing", async () => {
    config.huggingface.apiKey = "";

    const originalFallback = [...config.fallbackOrder];
    const originalHasCustom = config.hasCustomFallbackOrder;
    config.fallbackOrder = [TierName.HuggingFace];
    config.hasCustomFallbackOrder = true;

    try {
      const result = await routeRequest(baseReq).catch((e) => e);
      // Should throw because no tier succeeded
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("exhausted");
    } finally {
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
    }
  });

  it("sends Bearer token in Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await huggingfaceAdapter.send(baseReq);
    expect(capturedHeaders.Authorization).toBe("Bearer hf_test_key");
  });
});

describe("Hugging Face Adapter — basic completion", () => {
  it("returns an Anthropic-shaped response on success", async () => {
    globalThis.fetch = mock(async () =>
      makeOkResponse("Hello from HF!"),
    ) as unknown as typeof fetch;

    const response = await huggingfaceAdapter.send(baseReq);
    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content).toBeArray();
    const text = response.content.find((b) => b.type === "text");
    expect(text).toBeDefined();
    expect((text as any).text).toBe("Hello from HF!");
    expect(response.usage.input_tokens).toBe(10);
    expect(response.usage.output_tokens).toBe(5);
  });
});

describe("Hugging Face Adapter — tool calling", () => {
  it("maps OpenAI tool_calls to Anthropic tool_use blocks", async () => {
    globalThis.fetch = mock(async () => makeToolResponse()) as unknown as typeof fetch;

    const reqWithTools: NormalizedRequest = {
      ...baseReq,
      tools: [
        {
          name: "get_weather",
          description: "Get weather for a city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    };

    const response = await huggingfaceAdapter.send(reqWithTools);
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    expect(toolBlock).toBeDefined();
    expect((toolBlock as any).name).toBe("get_weather");
    expect((toolBlock as any).input).toEqual({ city: "Paris" });
    expect(response.stop_reason).toBe("tool_use");
  });
});

describe("Hugging Face Adapter — upstream provider routing", () => {
  it("injects x-hf-provider header when HF_PROVIDER is set", async () => {
    config.huggingface.provider = "groq";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await huggingfaceAdapter.send(baseReq);
    expect(capturedHeaders["x-hf-provider"]).toBe("groq");
  });

  it("does NOT inject x-hf-provider header when HF_PROVIDER is empty", async () => {
    config.huggingface.provider = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      return makeOkResponse();
    }) as unknown as typeof fetch;

    await huggingfaceAdapter.send(baseReq);
    expect(capturedHeaders["x-hf-provider"]).toBeUndefined();
  });
});

describe("Hugging Face Adapter — 429 rate limit", () => {
  it("throws ProviderError with status 429 and preserves retry-after headers", async () => {
    globalThis.fetch = mock(async () => make429Response()) as unknown as typeof fetch;

    let thrownError: any;
    try {
      await huggingfaceAdapter.send(baseReq);
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.status).toBe(429);
    expect(thrownError.headers).toBeDefined();
    // Verify retry-after header survives so retryAfterFromError can parse it
    expect(thrownError.headers.get("retry-after")).toBe("30");
  });
});

describe("Hugging Face Adapter — context overflow (router level)", () => {
  it("skips huggingface tier when request exceeds TPM limit", async () => {
    const originalFallback = [...config.fallbackOrder];
    const originalHasCustom = config.hasCustomFallbackOrder;
    const originalTpm = config.huggingface.limits.tpm;

    config.huggingface.limits.tpm = 50;
    config.fallbackOrder = [TierName.HuggingFace];
    config.hasCustomFallbackOrder = true;
    rateLimiter.reset();

    const bigReq: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "word ".repeat(500) }],
      tools: [],
      stream: false,
    };

    try {
      const result = await routeRequest(bigReq).catch((e) => e);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("exhausted");
    } finally {
      config.huggingface.limits.tpm = originalTpm;
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
      rateLimiter.reset();
    }
  });
});

describe("Hugging Face Adapter — timeout / network error", () => {
  it("propagates fetch network error and router marks it as failed attempt", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network timeout");
    }) as unknown as typeof fetch;

    const originalFallback = [...config.fallbackOrder];
    const originalHasCustom = config.hasCustomFallbackOrder;
    config.fallbackOrder = [TierName.HuggingFace];
    config.hasCustomFallbackOrder = true;
    rateLimiter.reset();

    try {
      const result = await routeRequest(baseReq).catch((e) => e);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("exhausted");
    } finally {
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
      rateLimiter.reset();
    }
  });
});

describe("Hugging Face Adapter — streaming", () => {
  it("sendStream returns a ReadableStream", () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        makeSseStream([
          JSON.stringify({
            id: "hf-stream-1",
            choices: [
              { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
            ],
          }),
          JSON.stringify({
            id: "hf-stream-2",
            choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
          }),
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const stream = huggingfaceAdapter.sendStream!(baseReq);
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
