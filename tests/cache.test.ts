import { describe, expect, it } from "bun:test";
import {
  ResponseCache,
  cacheKey,
  cacheStats,
  clearCache,
  getCached,
  setCached,
} from "../src/cache";
import type { AnthropicResponse, NormalizedRequest } from "../src/types";

describe("cache", () => {
  it("computes deterministic SHA-256 hash for normalized request", async () => {
    const req: NormalizedRequest = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello!" }],
      tools: [],
      temperature: 0.7,
      stream: false,
    };

    const key1 = await cacheKey(req);
    const key2 = await cacheKey({ ...req });

    expect(key1).toBe(key2);
    expect(key1.length).toBe(64);
  });

  it("stores and retrieves responses", async () => {
    clearCache();
    const key = "test-key-123";
    const response: AnthropicResponse = {
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "Cached response" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    expect(getCached(key)).toBeUndefined();
    setCached(key, response);
    expect(getCached(key)).toEqual(response);
  });

  it("includes sampling, model, budget and tools in the cache key", async () => {
    const base: NormalizedRequest = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello!" }],
      tools: [],
      stream: false,
    };

    const original = await cacheKey(base);
    expect(await cacheKey({ ...base, model: "other-model" })).not.toBe(original);
    expect(await cacheKey({ ...base, maxTokens: 100 })).not.toBe(original);
    expect(await cacheKey({ ...base, temperature: 0.2 })).not.toBe(original);
    expect(
      await cacheKey({
        ...base,
        tools: [{ name: "search", description: "search", input_schema: { type: "object" } }],
      }),
    ).not.toBe(original);
  });

  it("expires entries after the TTL", () => {
    let now = 1_000;
    const cache = new ResponseCache({ ttlMs: 100, maxEntries: 10, now: () => now });
    const response = {
      id: "msg_ttl",
      type: "message" as const,
      role: "assistant" as const,
      model: "test-model",
      content: [{ type: "text" as const, text: "Cached" }],
      stop_reason: "end_turn" as const,
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    cache.set("ttl-key", response);
    expect(cache.get("ttl-key")).toBe(response);

    now += 101;
    expect(cache.get("ttl-key")).toBeUndefined();
    expect(cache.stats().expired).toBe(1);
  });

  it("evicts the least recently used entry", () => {
    let now = 0;
    const cache = new ResponseCache({ ttlMs: 10_000, maxEntries: 2, now: () => now++ });
    const makeResponse = (id: string): AnthropicResponse => ({
      id,
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: id }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    cache.set("a", makeResponse("a"));
    cache.set("b", makeResponse("b"));
    cache.get("a");
    cache.set("c", makeResponse("c"));

    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("exposes stats through the shared cache", () => {
    clearCache();
    const stats = cacheStats();
    expect(stats.entries).toBe(0);
    expect(stats.maxEntries).toBeGreaterThan(0);
    expect(stats.ttlMs).toBeGreaterThan(0);
  });
});
