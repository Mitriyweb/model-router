import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cacheKey, clearCache, setCached } from "../../src/cache";
import { config } from "../../src/config";
import { POLICIES } from "../../src/policies";
import { adapters } from "../../src/providers";
import { rateLimiter } from "../../src/rateLimiter";
import { routeRequest, routeRequestStream } from "../../src/router";
import { AnthropicSSEWriter } from "../../src/streaming/anthropicSSE";
import type {
  AnthropicResponse,
  NormalizedRequest,
  PolicyRule,
  ProviderAdapter,
  TierName,
} from "../../src/types";

const STUB_TIERS: TierName[] = ["cerebras", "groq", "local"];

const req: NormalizedRequest = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [],
  stream: false,
};

interface AdapterStub {
  adapter: ProviderAdapter;
  calls: string[];
}

/** Adapter double that records calls and emits a valid Anthropic-format stream. */
function stubAdapter(tier: TierName, text: string, fail = false): AdapterStub {
  const calls: string[] = [];
  const response: AnthropicResponse = {
    id: `${tier}-id`,
    type: "message",
    role: "assistant",
    model: tier,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  return {
    calls,
    adapter: {
      tier,
      canHandle: () => true,
      async send() {
        calls.push("send");
        if (fail) throw new Error(`${tier} upstream failure`);
        return response;
      },
      sendStream() {
        calls.push("sendStream");
        if (fail) throw new Error(`${tier} upstream failure`);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            AnthropicSSEWriter.fromResponse(response, controller);
          },
        });
      },
    },
  };
}

describe("routing integration", () => {
  let stubs: Record<string, AdapterStub>;
  let originalAdapters: Partial<Record<TierName, ProviderAdapter>>;
  let originalPolicies: PolicyRule[];
  let snapshot: {
    fallbackOrder: TierName[];
    hasCustomFallbackOrder: boolean;
    cacheDisabled: boolean;
    routerMaxContextTokens: number;
    cerebrasKey: string;
    groqKey: string;
    cerebrasLimits: { rpm: number; tpm: number; rpd: number };
    groqLimits: { rpm: number; tpm: number; rpd: number };
  };

  beforeEach(async () => {
    snapshot = {
      fallbackOrder: [...config.fallbackOrder],
      hasCustomFallbackOrder: config.hasCustomFallbackOrder,
      cacheDisabled: config.cacheDisabled,
      routerMaxContextTokens: config.routerMaxContextTokens,
      cerebrasKey: config.cerebras.apiKey,
      groqKey: config.groq.apiKey,
      cerebrasLimits: { ...config.cerebras.limits },
      groqLimits: { ...config.groq.limits },
    };
    originalPolicies = [...POLICIES];

    config.fallbackOrder = ["cerebras", "groq", "local"];
    config.hasCustomFallbackOrder = true;
    config.cacheDisabled = true;
    config.routerMaxContextTokens = 100_000;
    config.cerebras.apiKey = "test-key";
    config.groq.apiKey = "test-key";
    config.cerebras.limits = { rpm: 100, tpm: 100_000, rpd: 100_000 };
    config.groq.limits = { rpm: 100, tpm: 100_000, rpd: 100_000 };

    originalAdapters = {};
    stubs = {
      // cerebras is first in the fallback order but fails by default, so normal
      // requests exercise the fallback path and land on groq.
      cerebras: stubAdapter("cerebras", "from cerebras", true),
      groq: stubAdapter("groq", "from groq"),
      local: stubAdapter("local", "from local"),
    };
    for (const tier of STUB_TIERS) {
      originalAdapters[tier] = adapters[tier];
      (adapters as Record<string, ProviderAdapter>)[tier] = stubs[tier]!.adapter;
    }

    await rateLimiter.reset();
    clearCache();
  });

  afterEach(async () => {
    for (const tier of STUB_TIERS) {
      const original = originalAdapters[tier];
      if (original) (adapters as Record<string, ProviderAdapter>)[tier] = original;
    }
    POLICIES.splice(0, POLICIES.length, ...originalPolicies);

    config.fallbackOrder = snapshot.fallbackOrder;
    config.hasCustomFallbackOrder = snapshot.hasCustomFallbackOrder;
    config.cacheDisabled = snapshot.cacheDisabled;
    config.routerMaxContextTokens = snapshot.routerMaxContextTokens;
    config.cerebras.apiKey = snapshot.cerebrasKey;
    config.groq.apiKey = snapshot.groqKey;
    config.cerebras.limits = snapshot.cerebrasLimits;
    config.groq.limits = snapshot.groqLimits;

    await rateLimiter.reset();
    clearCache();
  });

  it("falls through to the next tier when the first adapter fails", async () => {
    const result = await routeRequest(req);

    expect(result.tierUsed).toBe("groq");
    expect(result.response.content[0]).toEqual({ type: "text", text: "from groq" });
    expect(result.attempts).toEqual([{ tier: "cerebras", error: "cerebras upstream failure" }]);
    expect(stubs.groq!.calls).toEqual(["send"]);
  });

  it("falls through in streaming mode too", async () => {
    const result = await routeRequestStream({ ...req, stream: true });
    const sse = await new Response(result.stream).text();

    expect(result.tierUsed).toBe("groq");
    expect(sse).toContain("from groq");
    expect(result.attempts).toEqual([{ tier: "cerebras", error: "cerebras upstream failure" }]);
    expect(stubs.groq!.calls).toEqual(["sendStream"]);
  });

  it("calls only the forced tier for forceTier and forcePrivate", async () => {
    const forced = await routeRequest(req, { forceTier: "groq" });
    expect(forced.tierUsed).toBe("groq");
    expect(stubs.groq!.calls).toEqual(["send"]);
    expect(stubs.cerebras!.calls).toEqual([]);
    expect(stubs.local!.calls).toEqual([]);

    stubs.groq!.calls.length = 0;
    const privateResult = await routeRequest(req, { forcePrivate: true });
    expect(privateResult.tierUsed).toBe("local");
    expect(stubs.local!.calls).toEqual(["send"]);
    expect(stubs.groq!.calls).toEqual([]);
  });

  it("prefers forceTier when combined with forcePrivate", async () => {
    const result = await routeRequest(req, { forceTier: "groq", forcePrivate: true });

    expect(result.tierUsed).toBe("groq");
    expect(stubs.groq!.calls).toEqual(["send"]);
    expect(stubs.local!.calls).toEqual([]);
  });

  it("bypasses the deterministic cache policy when a tier is forced", async () => {
    config.cacheDisabled = false;
    const key = await cacheKey(req);
    setCached(key, {
      id: "cached-id",
      type: "message",
      role: "assistant",
      model: "cached-model",
      content: [{ type: "text", text: "from cache" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const cached = await routeRequest(req);
    expect(cached.tierUsed).toBe("deterministic");
    expect(cached.response.content[0]).toEqual({ type: "text", text: "from cache" });
    expect(stubs.groq!.calls).toEqual([]);

    const forced = await routeRequest(req, { forceTier: "groq" });
    expect(forced.tierUsed).toBe("groq");
    expect(forced.response.content[0]).toEqual({ type: "text", text: "from groq" });
    expect(stubs.groq!.calls).toEqual(["send"]);
  });

  it("serves an exact repeat from cache with a fresh response id", async () => {
    config.cacheDisabled = false;

    const first = await routeRequest(req);
    expect(first.tierUsed).toBe("groq");
    expect(stubs.groq!.calls).toEqual(["send"]);

    const second = await routeRequest(req);
    expect(second.tierUsed).toBe("deterministic");
    expect(second.policyApplied).toBe("exact-repeat-from-cache");
    expect(second.response.content[0]).toEqual({ type: "text", text: "from groq" });
    expect(second.response.id).not.toBe(first.response.id);
    expect(stubs.groq!.calls).toEqual(["send"]);
  });

  it("falls through to the tier loop on a cache miss", async () => {
    config.cacheDisabled = false;

    const result = await routeRequest(req);

    expect(result.tierUsed).toBe("groq");
    // The rule still matches and is reported, but its resolver missed, so the
    // tier loop did the real work.
    expect(result.policyApplied).toBe("exact-repeat-from-cache");
    expect(stubs.groq!.calls).toEqual(["send"]);
  });

  it("writes the successful response to the cache for later repeats", async () => {
    config.cacheDisabled = false;

    await routeRequest(req);
    const key = await cacheKey(req);
    const hit = (await routeRequest(req)).response;

    expect(hit.content[0]).toEqual({ type: "text", text: "from groq" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("moves a tier-policy target to the front and reports policyApplied", async () => {
    POLICIES.push({
      name: "prefer-local",
      description: "test rule",
      match: () => true,
      strategy: { kind: "tier", tier: "local" },
    });

    const result = await routeRequest(req);

    expect(result.tierUsed).toBe("local");
    expect(result.policyApplied).toBe("prefer-local");
    expect(stubs.local!.calls).toEqual(["send"]);
    expect(stubs.cerebras!.calls).toEqual([]);
  });

  it("uses the first matching policy", async () => {
    POLICIES.push({
      name: "first",
      match: () => true,
      strategy: { kind: "tier", tier: "local" },
    });
    POLICIES.push({
      name: "second",
      match: () => true,
      strategy: { kind: "tier", tier: "groq" },
    });

    const result = await routeRequest(req);

    expect(result.tierUsed).toBe("local");
    expect(result.policyApplied).toBe("first");
    expect(stubs.groq!.calls).toEqual([]);
  });

  it("skips a tier whose output budget reaches its TPM limit", async () => {
    config.fallbackOrder = ["groq"];
    config.groq.limits.tpm = 10;

    const error = await routeRequest({ ...req, maxTokens: 10 }).catch((err) => err);

    expect(error.attempts).toEqual([
      { tier: "groq", skipped: expect.stringContaining("exceeds TPM limit") },
    ]);
    expect(stubs.groq!.calls).toEqual([]);
  });

  it("treats a zero TPM limit as a hard zero allowance in the limiter", async () => {
    config.fallbackOrder = ["groq"];
    config.groq.limits.tpm = 0;

    const error = await routeRequest(req).catch((err) => err);

    expect(error.attempts).toEqual([{ tier: "groq", skipped: "rate limit reached" }]);
    expect(stubs.groq!.calls).toEqual([]);
  });

  it("caps the effective input budget with routerMaxContextTokens", async () => {
    config.fallbackOrder = ["groq"];
    config.routerMaxContextTokens = 8;
    let receivedMessages: NormalizedRequest["messages"] = [];
    stubs.groq!.adapter.send = async (request) => {
      receivedMessages = request.messages;
      return {
        id: "groq-id",
        type: "message",
        role: "assistant",
        model: "groq",
        content: [{ type: "text", text: "from groq" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    };

    const longReq: NormalizedRequest = {
      ...req,
      messages: [{ role: "user", content: "word ".repeat(200) }],
    };
    const result = await routeRequest(longReq);

    expect(result.tierUsed).toBe("groq");
    const firstMessage = receivedMessages[0];
    expect(firstMessage).toBeDefined();
    expect(typeof firstMessage!.content === "string" && firstMessage!.content.length).toBeLessThan(
      longReq.messages[0]!.content.length as number,
    );
  });
});
