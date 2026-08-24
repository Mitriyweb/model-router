import { describe, expect, it } from "bun:test";
import { rateLimiter } from "../src/rateLimiter";
import { retryAfterFromHeaders } from "../src/router";
import { TierName } from "../src/types";

describe("rateLimiter", () => {
  it("enforces rpm, tpm, and rpd limits", () => {
    rateLimiter.reset();

    const limits = { rpm: 2, tpm: 100, rpd: 5 };

    // Initially should be able to serve
    expect(rateLimiter.canServe(TierName.Groq, limits, 10)).toBe(true);

    // Record request 1
    rateLimiter.record(TierName.Groq, 40);
    expect(rateLimiter.canServe(TierName.Groq, limits, 10)).toBe(true);

    // Record request 2
    rateLimiter.record(TierName.Groq, 40);

    // Exceeds RPM limit (2 requests in 60s)
    expect(rateLimiter.canServe(TierName.Groq, limits, 10)).toBe(false);
  });

  it("checks token limits before serving", () => {
    rateLimiter.reset();
    const limits = { rpm: 10, tpm: 50, rpd: 100 };

    expect(rateLimiter.canServe(TierName.Gemini, limits, 30)).toBe(true);
    rateLimiter.record(TierName.Gemini, 30);

    // 30 tokens used + 30 requested > 50 TPM limit
    expect(rateLimiter.canServe(TierName.Gemini, limits, 30)).toBe(false);
  });

  it("temporarily skips a provider marked unavailable after a quota error", () => {
    rateLimiter.reset();
    const limits = { rpm: 10, tpm: 100, rpd: 100 };

    rateLimiter.markUnavailable(TierName.Gemini, 60_000);
    expect(rateLimiter.canServe(TierName.Gemini, limits, 10)).toBe(false);

    rateLimiter.reset();
    expect(rateLimiter.canServe(TierName.Gemini, limits, 10)).toBe(true);
  });

  it("allows a provider again after its cooldown expires", () => {
    rateLimiter.reset();
    const limits = { rpm: 10, tpm: 100, rpd: 100 };

    rateLimiter.markUnavailable(TierName.Groq, 0);
    expect(rateLimiter.canServe(TierName.Groq, limits, 10)).toBe(true);
  });

  it("logs the limiter snapshot when a provider is skipped for rate limits", () => {
    rateLimiter.reset();
    const warn = console.warn;
    const calls: any[] = [];
    console.warn = (...args: any[]) => calls.push(args);

    try {
      const limits = { rpm: 1, tpm: 10, rpd: 1 };
      rateLimiter.record(TierName.Groq, 10);
      expect(rateLimiter.canServe(TierName.Groq, limits, 1)).toBe(false);
      expect(calls.some(([msg]) => String(msg).includes("groq skip: rate limit reached"))).toBe(
        true,
      );
    } finally {
      console.warn = warn;
    }
  });

  it("extracts retry-after duration from HTTP headers", () => {
    const headers = new Headers({
      "x-ratelimit-reset-tokens": "2.5s",
    });
    const duration = retryAfterFromHeaders(headers);
    expect(duration).toBe(2500);
  });

  it("resets and clears persisted state immediately", async () => {
    await rateLimiter.reset();
    rateLimiter.record(TierName.Groq, 100);
    expect(
      rateLimiter.snapshot(TierName.Groq, { rpm: 10, tpm: 1000, rpd: 100 }).requestsThisMinute,
    ).toBe(1);

    await rateLimiter.reset();
    expect(
      rateLimiter.snapshot(TierName.Groq, { rpm: 10, tpm: 1000, rpd: 100 }).requestsThisMinute,
    ).toBe(0);
  });
});
