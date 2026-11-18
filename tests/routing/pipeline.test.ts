import { afterEach, describe, expect, it, mock } from "bun:test";
import { config } from "../../src/config";
import { POLICIES } from "../../src/policies";
import { adapters } from "../../src/providers";
import { rateLimiter } from "../../src/rateLimiter";
import { routeRequestStream } from "../../src/router";
import { prepareAttempt } from "../../src/routing/attempt";
import { deterministicRule, planRoute, planTierOrder } from "../../src/routing/planner";
import type { NormalizedRequest, PolicyRule } from "../../src/types";

const baseReq: NormalizedRequest = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [],
  stream: false,
};

const originalFallback = [...config.fallbackOrder];
const originalHasCustom = config.hasCustomFallbackOrder;
const originalCacheDisabled = config.cacheDisabled;
const originalRouterMaxContext = config.routerMaxContextTokens;
const originalGroqKey = config.groq.apiKey;
const originalGroqTpm = config.groq.limits.tpm;
const originalGroqRpm = config.groq.limits.rpm;
const originalPolicies = [...POLICIES];

afterEach(async () => {
  config.fallbackOrder = [...originalFallback];
  config.hasCustomFallbackOrder = originalHasCustom;
  config.cacheDisabled = originalCacheDisabled;
  config.routerMaxContextTokens = originalRouterMaxContext;
  config.groq.apiKey = originalGroqKey;
  config.groq.limits.tpm = originalGroqTpm;
  config.groq.limits.rpm = originalGroqRpm;
  POLICIES.splice(0, POLICIES.length, ...originalPolicies);
  await rateLimiter.reset();
});

describe("planner", () => {
  it("prefers Gemini then Mistral for large contexts", () => {
    config.hasCustomFallbackOrder = false;

    expect(planTierOrder(baseReq, 5000)).toEqual([
      "gemini",
      "mistral",
      "cerebras",
      "openrouter",
      "groq",
      "nvidia",
      "huggingface",
      "cloudflare",
      "cohere",
      "local",
    ]);
  });

  it("respects a custom fallback order even for large contexts", () => {
    config.hasCustomFallbackOrder = true;
    config.fallbackOrder = ["openrouter", "groq"];

    expect(planTierOrder(baseReq, 50_000)).toEqual(["openrouter", "groq"]);
  });

  it("supports forced tier and forced-private routing", () => {
    expect(planTierOrder(baseReq, 10, { forceTier: "groq" })).toEqual(["groq"]);
    expect(planTierOrder(baseReq, 10, { forcePrivate: true })).toEqual(["local"]);
  });

  it("moves a tier policy target to the front of the plan", () => {
    config.cacheDisabled = true;
    const rule: PolicyRule = {
      name: "test-force-groq",
      match: (req) => req.systemPrompt.includes("helpful"),
      strategy: { kind: "tier", tier: "groq" },
    };
    POLICIES.push(rule);

    const plan = planRoute(baseReq);

    expect(plan.rule).toBe(rule);
    expect(plan.order[0]).toBe("groq");
    expect(plan.order.filter((tier) => tier === "groq")).toHaveLength(1);
  });

  it("exposes the deterministic cache policy unless a tier is forced", () => {
    const plan = planRoute(baseReq);

    expect(deterministicRule(plan)?.name).toBe("exact-repeat-from-cache");
    expect(deterministicRule(plan, { forceTier: "groq" })).toBeUndefined();
  });
});

describe("attempt preparation", () => {
  it("skips tiers without credentials", () => {
    config.groq.apiKey = "";

    expect(prepareAttempt("groq", baseReq, 10)).toEqual({
      kind: "skip",
      reason: "no API key/token configured",
    });
  });

  it("returns a ready attempt with budget accounting", () => {
    config.groq.apiKey = "test-key";
    config.groq.limits.tpm = 6000;

    const preparation = prepareAttempt("groq", baseReq, 100);

    expect(preparation.kind).toBe("ready");
    if (preparation.kind !== "ready") return;
    expect(preparation.attempt.tier).toBe("groq");
    expect(preparation.attempt.budgetTokens).toBe(100);
    expect(preparation.attempt.prunedFrom).toBeUndefined();
  });

  it("prunes requests that exceed the target input limit", () => {
    config.groq.apiKey = "test-key";
    config.groq.limits.tpm = 6000;

    const bigReq: NormalizedRequest = {
      ...baseReq,
      maxTokens: 4000,
      messages: [{ role: "user", content: "word ".repeat(5000) }],
    };
    const estimated = 20_000;

    const preparation = prepareAttempt("groq", bigReq, estimated);

    expect(preparation.kind).toBe("ready");
    if (preparation.kind !== "ready") return;
    expect(preparation.attempt.prunedFrom).toBe(estimated);
    expect(preparation.attempt.estimatedTokens).toBeLessThan(estimated);
    expect(preparation.attempt.budgetTokens).toBeLessThanOrEqual(6000);
  });

  it("skips when the budget cannot fit the tier TPM limit", () => {
    config.groq.apiKey = "test-key";
    config.groq.limits.tpm = 100;

    const preparation = prepareAttempt("groq", { ...baseReq, maxTokens: 1000 }, 10);

    expect(preparation.kind).toBe("skip");
    if (preparation.kind !== "skip") return;
    expect(preparation.reason).toContain("exceeds TPM limit");
  });

  it("skips when the adapter cannot handle the context", () => {
    config.groq.apiKey = "test-key";
    config.routerMaxContextTokens = 1;

    expect(prepareAttempt("groq", baseReq, 100)).toEqual({
      kind: "skip",
      reason: "request doesn't fit this tier (context/size)",
    });
  });

  it("skips when the rate limit is reached", async () => {
    config.groq.apiKey = "test-key";
    config.groq.limits.rpm = 1;
    rateLimiter.record("groq", 1);

    expect(prepareAttempt("groq", baseReq, 10)).toEqual({
      kind: "skip",
      reason: "rate limit reached",
    });
  });

  it("skips targets without streaming support when stream is required", () => {
    const original = adapters.local;
    (adapters as Record<string, unknown>).local = { ...original, sendStream: undefined };

    try {
      expect(prepareAttempt("local", baseReq, 10, { requireStream: true })).toEqual({
        kind: "skip",
        reason: "streaming not supported",
      });
    } finally {
      (adapters as Record<string, unknown>).local = original;
    }
  });
});

describe("streaming pipeline", () => {
  it("reports skip reasons instead of dropping tiers silently", async () => {
    config.cacheDisabled = true;
    config.groq.apiKey = "";
    config.fallbackOrder = ["groq"];
    config.hasCustomFallbackOrder = true;

    const error: any = await routeRequestStream(baseReq).catch((err) => err);

    expect(error.attempts).toEqual([{ tier: "groq", skipped: "no API key/token configured" }]);
  });

  it("records usage only after the stream completes", async () => {
    config.cacheDisabled = true;
    config.groq.apiKey = "test-key";
    config.groq.limits.tpm = 100_000;
    config.groq.limits.rpm = 100;
    config.fallbackOrder = ["groq"];
    config.hasCustomFallbackOrder = true;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const before = rateLimiter.snapshot("groq", config.groq.limits).requestsThisMinute;
      const result = await routeRequestStream({ ...baseReq, stream: true });

      expect(rateLimiter.snapshot("groq", config.groq.limits).requestsThisMinute).toBe(before);

      await new Response(result.stream).text();

      expect(rateLimiter.snapshot("groq", config.groq.limits).requestsThisMinute).toBe(before + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
