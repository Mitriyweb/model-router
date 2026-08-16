import { describe, expect, it } from "bun:test";
import { config } from "../src/config";
import { estimateTokens, planTierOrder } from "../src/router";
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
});
