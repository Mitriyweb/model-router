import { describe, expect, it } from "bun:test";
import { cacheKey, clearCache, getCached, setCached } from "../src/cache";
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
});
