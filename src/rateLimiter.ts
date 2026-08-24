import type { TierLimits, TierName } from "./types";

interface Usage {
  requestTimestamps: number[]; // for RPM window (60s)
  tokenTimestamps: { at: number; tokens: number }[]; // for TPM window (60s)
  dayTimestamps: number[]; // for RPD window (24h)
}

const MINUTE = 60_000;
const DAY = 24 * 60 * 60_000;

const STATE_FILE = process.env.RATE_LIMIT_STATE_FILE ?? ".router-state.json";

type PersistedState = Record<TierName, Usage>;

export class RateLimiter {
  private usage = new Map<TierName, Usage>();
  private unavailableUntil = new Map<TierName, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded: Promise<void>;

  constructor() {
    this.loaded = this.load();
  }

  private async load() {
    try {
      const file = Bun.file(STATE_FILE);
      if (await file.exists()) {
        const data: PersistedState = await file.json();
        for (const [tier, usage] of Object.entries(data)) {
          this.usage.set(tier as TierName, usage);
        }
      }
      const now = Date.now();
      for (const [tier, usage] of this.usage.entries()) {
        this.prune(usage, now);
        this.cleanupIfEmpty(tier as TierName, usage);
      }
      await this.saveImmediately();
    } catch (err) {
      console.warn(`[rateLimiter] couldn't load ${STATE_FILE}, starting fresh:`, err);
    }
  }

  public async saveImmediately() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const obj = Object.fromEntries(this.usage.entries());
    try {
      await Bun.write(STATE_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.warn(`[rateLimiter] couldn't save ${STATE_FILE}:`, err);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveImmediately();
    }, 500);
  }

  private getUsage(tier: TierName): Usage {
    if (!this.usage.has(tier)) {
      this.usage.set(tier, { requestTimestamps: [], tokenTimestamps: [], dayTimestamps: [] });
    }
    return this.usage.get(tier)!;
  }

  private prune(usage: Usage, now: number) {
    usage.requestTimestamps = usage.requestTimestamps.filter((t) => now - t < MINUTE);
    usage.tokenTimestamps = usage.tokenTimestamps.filter((t) => now - t.at < MINUTE);
    usage.dayTimestamps = usage.dayTimestamps.filter((t) => now - t < DAY);
  }

  private cleanupIfEmpty(tier: TierName, usage: Usage) {
    if (
      usage.requestTimestamps.length === 0 &&
      usage.tokenTimestamps.length === 0 &&
      usage.dayTimestamps.length === 0
    ) {
      this.usage.delete(tier);
    }
  }

  canServe(tier: TierName, limits: TierLimits, estimatedTokens: number): boolean {
    const now = Date.now();
    const unavailableUntil = this.unavailableUntil.get(tier) ?? 0;
    if (unavailableUntil > now) {
      console.warn(
        `[rateLimiter] ${tier} unavailable until ${new Date(unavailableUntil).toISOString()}`,
      );
      return false;
    }
    if (unavailableUntil > 0) {
      this.unavailableUntil.delete(tier);
    }

    const usage = this.getUsage(tier);
    this.prune(usage, now);

    const tokensInWindow = usage.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    const snapshot = this.snapshot(tier, limits);
    const canServe =
      usage.requestTimestamps.length < limits.rpm &&
      usage.dayTimestamps.length < limits.rpd &&
      tokensInWindow + estimatedTokens <= limits.tpm;

    if (!canServe) {
      console.warn(`[rateLimiter] ${tier} skip: rate limit reached`, JSON.stringify(snapshot));
    }

    this.cleanupIfEmpty(tier, usage);

    return canServe;
  }

  record(tier: TierName, tokensUsed: number) {
    const now = Date.now();
    const usage = this.getUsage(tier);
    usage.requestTimestamps.push(now);
    usage.dayTimestamps.push(now);
    usage.tokenTimestamps.push({ at: now, tokens: tokensUsed });
    this.scheduleSave();
  }

  markUnavailable(tier: TierName, durationMs: number) {
    this.unavailableUntil.set(tier, Date.now() + durationMs);
  }

  private removeExpiredCooldown(tier: TierName): void {
    const unavailableUntil = this.unavailableUntil.get(tier);
    if (unavailableUntil && unavailableUntil <= Date.now()) {
      this.unavailableUntil.delete(tier);
    }
  }

  ready() {
    return this.loaded;
  }

  snapshot(tier: TierName, limits: TierLimits) {
    const now = Date.now();
    const usage = this.getUsage(tier);
    this.prune(usage, now);
    const tokensInWindow = usage.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    const snapshotData = {
      requestsThisMinute: usage.requestTimestamps.length,
      requestsToday: usage.dayTimestamps.length,
      tokensThisMinute: tokensInWindow,
      limits,
    };
    this.cleanupIfEmpty(tier, usage);
    return snapshotData;
  }

  async reset() {
    this.usage.clear();
    this.unavailableUntil.clear();
    await this.saveImmediately();
  }
}

export function retryAfterFromHeaders(headers?: Headers): number | undefined {
  if (!headers) return undefined;

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(1_000, Math.ceil(seconds * 1_000));
    }
  }

  for (const name of [
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset",
  ]) {
    const val = headers.get(name)?.trim();
    if (val) {
      if (val.endsWith("ms")) {
        const ms = Number.parseFloat(val.slice(0, -2));
        if (Number.isFinite(ms)) return Math.max(1_000, Math.ceil(ms));
      } else if (val.endsWith("s")) {
        const s = Number.parseFloat(val.slice(0, -1));
        if (Number.isFinite(s)) return Math.max(1_000, Math.ceil(s * 1_000));
      } else if (val.endsWith("m")) {
        const m = Number.parseFloat(val.slice(0, -1));
        if (Number.isFinite(m)) return Math.max(1_000, Math.ceil(m * 60_000));
      }
      const num = Number.parseFloat(val);
      if (Number.isFinite(num)) {
        if (num > 1e9) {
          const now = Date.now();
          const target = num < 1e11 ? num * 1_000 : num;
          return Math.max(1_000, Math.ceil(target - now));
        }
        return Math.max(1_000, Math.ceil(num * 1_000));
      }
    }
  }

  return undefined;
}

export function retryAfterFromError(err: unknown): number | undefined {
  if (err && typeof err === "object" && "headers" in err && (err as any).headers) {
    const headerRetry = retryAfterFromHeaders((err as any).headers);
    if (headerRetry !== undefined) return headerRetry;
  }
  if (
    err &&
    typeof err === "object" &&
    "retryAfterMs" in err &&
    typeof (err as any).retryAfterMs === "number"
  ) {
    return (err as any).retryAfterMs;
  }

  const message = err instanceof Error ? err.message : String(err);
  const isRateLimitSignal =
    /resource has been exhausted|resource_exhausted|quota exceeded|quota|exhausted|rate limit|too many requests|rate_limit_exceeded|tokens per minute|tpm.*limit|limit .* requested .* try again|out of credit|credit limit|overloaded/i.test(
      message,
    ) ||
    (err &&
      typeof err === "object" &&
      "status" in err &&
      ((err as any).status === 429 || (err as any).status === 413 || (err as any).status === 503));

  if (!isRateLimitSignal) return undefined;

  const match = message.match(
    /retry\s+(?:in|after)\s+([\d.]+)\s*(ms|milliseconds|s|seconds|sec|m|minutes|min)?/i,
  );
  if (!match) return 60_000;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 60_000;

  let multiplier = 1_000;
  const unit = match[2]?.toLowerCase();
  if (unit) {
    if (unit.startsWith("ms") || unit.startsWith("milli")) {
      multiplier = 1;
    } else if (unit.startsWith("min") || unit === "m") {
      multiplier = 60_000;
    } else if (unit.startsWith("s")) {
      multiplier = 1_000;
    }
  }

  return Math.max(1_000, Math.ceil(amount * multiplier));
}

export const rateLimiter = new RateLimiter();
