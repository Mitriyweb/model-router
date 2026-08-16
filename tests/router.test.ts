import { describe, expect, it, mock } from "bun:test";
import { sanitizeGeminiSchema } from "../src/adapters/gemini";
import { readProviderError } from "../src/adapters/openaiCompatible";
import { config } from "../src/config";
import { POLICIES } from "../src/policies";
import { estimateTokens, planTierOrder } from "../src/router";
import { startServer } from "../src/server";
import type { NormalizedRequest } from "../src/types";

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

    expect(planTierOrder(smallReq, 50)).toEqual(config.fallbackOrder);

    // Large context (>4000 tokens) prefers Gemini first
    const largePlan = planTierOrder(smallReq, 5000);
    expect(largePlan[0]).toBe("gemini");

    // Force private stays completely local
    expect(planTierOrder(smallReq, 50, { forcePrivate: true })).toEqual(["local"]);
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
    config.fallbackOrder = ["gemini", "openrouter", "mistral"];
    config.hasCustomFallbackOrder = true;

    try {
      expect(planTierOrder(req, 5000)).toEqual(["gemini", "openrouter", "mistral"]);
    } finally {
      config.fallbackOrder = originalFallback;
      config.hasCustomFallbackOrder = originalHasCustom;
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
});
