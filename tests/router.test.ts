import { describe, expect, it, mock } from "bun:test";
import { cerebrasAdapter } from "../src/adapters/cerebras";
import { sanitizeGeminiSchema } from "../src/adapters/gemini";
import { groqAdapter } from "../src/adapters/groq";
import { mistralAdapter } from "../src/adapters/mistral";
import { readProviderError } from "../src/adapters/openaiCompatible";
import { config } from "../src/config";
import { POLICIES } from "../src/policies";
import { rateLimiter } from "../src/rateLimiter";
import { estimateTokens, planTierOrder, routeRequest } from "../src/router";
import { startServer } from "../src/server";
import type { NormalizedRequest } from "../src/types";
import { TierName } from "../src/types";

describe("router", () => {
  it("estimates token counts consistently", () => {
    const req: NormalizedRequest = {
      systemPrompt: "You are a helpful coding assistant.",
      messages: [{ role: "user", content: "Write a quicksort implementation in TypeScript." }],
      tools: [],
      stream: false,
    };

    const count = estimateTokens(req);
    expect(count).toBeGreaterThan(5);
  });

  it("plans tier order based on request size and options", () => {
    const smallReq: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      stream: false,
    };

    const originalFallback = [...config.fallbackOrder];
    const originalHasCustom = config.hasCustomFallbackOrder;
    config.fallbackOrder = [
      TierName.Cerebras,
      TierName.Groq,
      TierName.Gemini,
      TierName.OpenRouter,
      TierName.Mistral,
      TierName.Nvidia,
      TierName.Cloudflare,
      TierName.Cohere,
      TierName.Local,
    ];
    config.hasCustomFallbackOrder = false;

    try {
      expect(planTierOrder(smallReq, 50)).toEqual(config.fallbackOrder);

      // Large context (>4000 tokens) prefers Gemini first
      const largePlan = planTierOrder(smallReq, 5000);
      expect(largePlan[0]).toBe(TierName.Gemini);

      // Force private stays completely local
      expect(planTierOrder(smallReq, 50, { forcePrivate: true })).toEqual([TierName.Local]);
    } finally {
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
    }
  });

  it("respects explicit fallback order even for larger requests", () => {
    const req: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      stream: false,
    };

    const originalFallback = [...config.fallbackOrder];
    const originalHasCustom = config.hasCustomFallbackOrder;
    config.fallbackOrder = [TierName.Gemini, TierName.OpenRouter, TierName.Mistral];
    config.hasCustomFallbackOrder = true;

    try {
      expect(planTierOrder(req, 5000)).toEqual([
        TierName.Gemini,
        TierName.OpenRouter,
        TierName.Mistral,
      ]);
    } finally {
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
    }
  });

  it("supports context pruning for Groq requests when estimated tokens exceed limit", () => {
    const req: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "Hello there! This is a normal request." }],
      tools: [],
      stream: false,
    };

    expect(groqAdapter.canHandle(req, 5000)).toBe(true);
  });

  it("skips a tier if post-pruning request size still exceeds tier TPM limit", async () => {
    const req: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "Hello there! ".repeat(50) }],
      tools: [],
      stream: false,
    };

    const originalApiKey = config.groq.apiKey;
    const originalFallback = [...config.fallbackOrder];
    const originalHasCustom = config.hasCustomFallbackOrder;
    const originalTpm = config.groq.limits.tpm;

    config.groq.apiKey = "test-key";
    config.groq.limits.tpm = 50;
    config.fallbackOrder = [TierName.Groq];
    config.hasCustomFallbackOrder = true;

    try {
      await expect(routeRequest(req)).rejects.toThrow("All tiers exhausted or unavailable");
    } finally {
      config.groq.apiKey = originalApiKey;
      config.groq.limits.tpm = originalTpm;
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
    }
  });

  it("supports context pruning for Cerebras requests when estimated tokens exceed limit", () => {
    const req: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "Hello there! This is a normal request." }],
      tools: [],
      stream: false,
    };

    expect(cerebrasAdapter.canHandle(req, 5000)).toBe(true);
  });

  it("marks Groq unavailable when upstream reports a TPM rate-limit error", async () => {
    const req: NormalizedRequest = {
      systemPrompt: "Please use the tools for the task.",
      messages: [{ role: "user", content: "Summarize this request in detail." }],
      tools: [],
      stream: false,
    };

    const originalFetch = globalThis.fetch;
    const originalApiKey = config.groq.apiKey;
    const originalBaseUrl = config.groq.baseUrl;
    const originalFallback = [...config.fallbackOrder];
    const originalHasCustom = config.hasCustomFallbackOrder;

    rateLimiter.reset();
    config.groq.apiKey = "test-key";
    config.groq.baseUrl = "https://example.invalid";
    config.fallbackOrder = [TierName.Groq];
    config.hasCustomFallbackOrder = false;

    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Request too large for model `openai/gpt-oss-120b` ... Limit 8000, Requested 76706, please reduce your message size and try again.",
              type: "tokens",
              code: "rate_limit_exceeded",
            },
          }),
          {
            status: 413,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(routeRequest(req)).rejects.toThrow("All tiers exhausted or unavailable");
      expect(rateLimiter.canServe(TierName.Groq, config.groq.limits, 1000)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      config.groq.apiKey = originalApiKey;
      config.groq.baseUrl = originalBaseUrl;
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
      rateLimiter.reset();
    }
  });

  it("starts the HTTP server with a longer idle timeout for streaming requests", () => {
    const originalServe = Bun.serve;
    const serveMock = mock(() => ({
      port: 8787,
    }));

    (Bun as any).serve = serveMock;

    try {
      startServer(8787);
      expect(serveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8787,
          idleTimeout: 60,
        }),
      );
    } finally {
      (Bun as any).serve = originalServe;
    }
  });

  it("lets debug mode disable the exact-repeat cache policy", () => {
    const req: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      stream: false,
    };

    const previous = config.cacheDisabled;
    config.cacheDisabled = true;

    try {
      expect(POLICIES[0].match(req)).toBe(false);
    } finally {
      config.cacheDisabled = previous;
    }
  });

  it("formats unavailable model errors clearly for providers", async () => {
    const res = new Response(JSON.stringify({ error: { message: "model not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });

    const err = await readProviderError(res, "OpenRouter", "openai/gpt-oss-120b:free");
    expect(err).toContain("OpenRouter");
    expect(err).toContain("openai/gpt-oss-120b:free");
    expect(err).toContain("not available");
  });

  it("removes unsupported JSON Schema fields before Gemini tool payloads are sent", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        value: {
          type: "string",
          const: "x",
          additionalProperties: false,
        },
      },
      required: ["value"],
    };

    const cleaned = sanitizeGeminiSchema(input) as Record<string, unknown>;
    expect(cleaned).not.toHaveProperty("$schema");
    expect(cleaned).not.toHaveProperty("additionalProperties");
    expect(cleaned.properties).toEqual({
      value: {
        type: "string",
      },
    });
  });

  it("marks Gemini unavailable when upstream reports resource quota exhaustion", async () => {
    const req: NormalizedRequest = {
      systemPrompt: "Hi",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
      stream: false,
    };

    const originalFetch = globalThis.fetch;
    const originalApiKey = config.gemini.apiKey;
    const originalFallback = [...config.fallbackOrder];

    await rateLimiter.reset();
    config.gemini.apiKey = "test-key";
    config.fallbackOrder = [TierName.Gemini];

    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                'Gemini request failed for model "gemini-3.7-flash": Resource has been exhausted (e.g. check quota).',
              code: 429,
            },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(routeRequest(req)).rejects.toThrow("All tiers exhausted or unavailable");
      expect(rateLimiter.canServe(TierName.Gemini, config.gemini.limits, 100)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      config.gemini.apiKey = originalApiKey;
      config.fallbackOrder = originalFallback;
      await rateLimiter.reset();
    }
  });

  it("prunes large requests for Mistral when estimated tokens exceed target limit", () => {
    const req: NormalizedRequest = {
      systemPrompt: "System",
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message block ${i}: ${"hello world ".repeat(20)}`,
      })),
      tools: [],
      stream: false,
    };

    expect(mistralAdapter.canHandle(req, estimateTokens(req))).toBe(true);
  });
});
