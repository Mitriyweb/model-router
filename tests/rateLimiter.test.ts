import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RateLimiter, rateLimiter } from "../src/rateLimiter";
import { retryAfterFromHeaders } from "../src/router";

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

  it("allows a provider again after its cooldown expires", () => {
    rateLimiter.reset();
    const limits = { rpm: 10, tpm: 100, rpd: 100 };

    rateLimiter.markUnavailable("groq", 0);
    expect(rateLimiter.canServe("groq", limits, 10)).toBe(true);
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

  it("extracts retry-after duration from HTTP headers", () => {
    const headers = new Headers({
      "x-ratelimit-reset-tokens": "2.5s",
    });
    const duration = retryAfterFromHeaders(headers);
    expect(duration).toBe(2500);
  });

  it("extracts retry duration from Gemini quota error messages", () => {
    const { retryAfterFromError } = require("../src/rateLimiter");
    const geminiErrorMsg = `Gemini request failed for model "gemini-3.5-flash": You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash\nPlease retry in 908.96054ms.`;

    const ms = retryAfterFromError(new Error(geminiErrorMsg));
    expect(ms).toBe(1000); // 908.96054ms rounded up with min 1000ms limit

    const geminiSecErrorMsg = "Quota exceeded. Please retry in 12.5s.";
    expect(retryAfterFromError(new Error(geminiSecErrorMsg))).toBe(12500);
  });

  it("resets and clears persisted state immediately", async () => {
    await rateLimiter.reset();
    rateLimiter.record("groq", 100);
    expect(rateLimiter.snapshot("groq", { rpm: 10, tpm: 1000, rpd: 100 }).requestsThisMinute).toBe(
      1,
    );

    await rateLimiter.reset();
    expect(rateLimiter.snapshot("groq", { rpm: 10, tpm: 1000, rpd: 100 }).requestsThisMinute).toBe(
      0,
    );
  });
});

describe("rateLimiter persistence", () => {
  const limits = { rpm: 10, tpm: 1000, rpd: 100 };

  it("loads persisted state before ready() resolves", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-limiter-"));
    const stateFile = path.join(directory, "state.json");
    const now = Date.now();
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        groq: {
          requestTimestamps: [now - 1_000],
          tokenTimestamps: [{ at: now - 1_000, tokens: 50 }],
          dayTimestamps: [now - 1_000],
        },
      }),
    );

    try {
      const limiter = new RateLimiter(stateFile);
      await limiter.ready();

      const snapshot = limiter.snapshot("groq", limits);
      expect(snapshot.requestsThisMinute).toBe(1);
      expect(snapshot.tokensThisMinute).toBe(50);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes state atomically without leaving temporary files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-limiter-"));
    const stateFile = path.join(directory, "state.json");

    try {
      const limiter = new RateLimiter(stateFile);
      await limiter.ready();
      limiter.record("groq", 100);
      await limiter.saveImmediately();

      expect(fs.existsSync(stateFile)).toBe(true);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).groq.requestTimestamps).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caps and sanitizes persisted arrays and ignores unknown tiers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-limiter-"));
    const stateFile = path.join(directory, "state.json");
    const now = Date.now();
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        groq: {
          requestTimestamps: Array.from({ length: 20_000 }, () => now - 1_000),
          tokenTimestamps: Array.from({ length: 20_000 }, () => ({ at: now - 1_000, tokens: 1 })),
          dayTimestamps: Array.from({ length: 20_000 }, () => now - 1_000),
        },
        unknownTier: {
          requestTimestamps: [now],
          tokenTimestamps: [],
          dayTimestamps: [now],
        },
      }),
    );

    try {
      const limiter = new RateLimiter(stateFile);
      await limiter.ready();
      await limiter.saveImmediately();

      const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      expect(persisted.unknownTier).toBeUndefined();
      expect(persisted.groq.requestTimestamps.length).toBeLessThanOrEqual(10_000);
      expect(persisted.groq.tokenTimestamps.length).toBeLessThanOrEqual(10_000);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
