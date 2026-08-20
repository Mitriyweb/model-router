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
        if (
          usage.requestTimestamps.length === 0 &&
          usage.tokenTimestamps.length === 0 &&
          usage.dayTimestamps.length === 0
        ) {
          this.usage.delete(tier as TierName);
        }
      }
    } catch (err) {
      console.warn(`[rateLimiter] couldn't load ${STATE_FILE}, starting fresh:`, err);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      const obj = Object.fromEntries(this.usage.entries());
      try {
        await Bun.write(STATE_FILE, JSON.stringify(obj, null, 2));
      } catch (err) {
        console.warn(`[rateLimiter] couldn't save ${STATE_FILE}:`, err);
      }
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
    return {
      requestsThisMinute: usage.requestTimestamps.length,
      requestsToday: usage.dayTimestamps.length,
      tokensThisMinute: tokensInWindow,
      limits,
    };
  }

  reset() {
    this.usage.clear();
    this.unavailableUntil.clear();
    this.scheduleSave();
  }
}

export const rateLimiter = new RateLimiter();
