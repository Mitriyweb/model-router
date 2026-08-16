import { describe, expect, it } from "bun:test";
import { rateLimiter } from "../src/rateLimiter";

describe("rateLimiter", () => {
  it("enforces rpm, tpm, and rpd limits", () => {
    rateLimiter.reset();

    const limits = { rpm: 2, tpm: 100, rpd: 5 };

    // Initially should be able to serve
    expect(rateLimiter.canServe("groq", limits, 10)).toBe(true);

    // Record request 1
    rateLimiter.record("groq", 40);
    expect(rateLimiter.canServe("groq", limits, 10)).toBe(true);

    // Record request 2
    rateLimiter.record("groq", 40);

    // Exceeds RPM limit (2 requests in 60s)
    expect(rateLimiter.canServe("groq", limits, 10)).toBe(false);
  });

  it("checks token limits before serving", () => {
    rateLimiter.reset();
    const limits = { rpm: 10, tpm: 50, rpd: 100 };

    expect(rateLimiter.canServe("gemini", limits, 30)).toBe(true);
    rateLimiter.record("gemini", 30);

    // 30 tokens used + 30 requested > 50 TPM limit
    expect(rateLimiter.canServe("gemini", limits, 30)).toBe(false);
  });
});
