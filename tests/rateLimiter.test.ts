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

  it("temporarily skips a provider marked unavailable after a quota error", () => {
    rateLimiter.reset();
    const limits = { rpm: 10, tpm: 100, rpd: 100 };

    rateLimiter.markUnavailable("gemini", 60_000);
    expect(rateLimiter.canServe("gemini", limits, 10)).toBe(false);

    rateLimiter.reset();
    expect(rateLimiter.canServe("gemini", limits, 10)).toBe(true);
  });

  it("logs the limiter snapshot when a provider is skipped for rate limits", () => {
    rateLimiter.reset();
    const warn = console.warn;
    const calls: any[] = [];
    console.warn = (...args: any[]) => calls.push(args);

    try {
      const limits = { rpm: 1, tpm: 10, rpd: 1 };
      rateLimiter.record("groq", 10);
      expect(rateLimiter.canServe("groq", limits, 1)).toBe(false);
      expect(calls.some(([msg]) => String(msg).includes("groq skip: rate limit reached"))).toBe(
        true,
      );
    } finally {
      console.warn = warn;
    }
  });
});
