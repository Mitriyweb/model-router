import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { log } from "./log";
import { VALID_TIERS } from "./providers/definitions";
import type { TierLimits, TierName } from "./types";

interface Usage {
  requestTimestamps: number[]; // for RPM window (60s)
  tokenTimestamps: { at: number; tokens: number }[]; // for TPM window (60s)
  dayTimestamps: number[]; // for RPD window (24h)
}

const MINUTE = 60_000;
const DAY = 24 * 60 * 60_000;
const MAX_PERSISTED_ENTRIES = 10_000;
const MAX_PERSISTED_TOKENS = 1_000_000_000;

const DEFAULT_STATE_FILE = config.stateFile;

function emptyUsage(): Usage {
  return { requestTimestamps: [], tokenTimestamps: [], dayTimestamps: [] };
}

function finiteNumbers(value: unknown, now: number, windowMs: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is number =>
        typeof entry === "number" &&
        Number.isFinite(entry) &&
        entry > 0 &&
        entry <= now &&
        now - entry < windowMs,
    )
    .slice(-MAX_PERSISTED_ENTRIES)
    .sort((a, b) => a - b);
}

/** Reject corrupt or hostile persisted arrays and cap their memory footprint. */
function normalizeUsage(value: unknown, now: number): Usage {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const tokenEntries = Array.isArray(raw.tokenTimestamps) ? raw.tokenTimestamps : [];
  const capped: { at: number; tokens: number }[] = [];
  let totalTokens = 0;

  for (let index = tokenEntries.length - 1; index >= 0; index -= 1) {
    if (capped.length >= MAX_PERSISTED_ENTRIES) break;
    const entry = tokenEntries[index] as Record<string, unknown> | null;
    const at = entry?.at;
    const tokens = entry?.tokens;
    if (
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      at > now ||
      now - at >= MINUTE ||
      typeof tokens !== "number" ||
      !Number.isFinite(tokens) ||
      tokens < 0
    ) {
      continue;
    }
    if (totalTokens + tokens > MAX_PERSISTED_TOKENS) continue;
    capped.push({ at, tokens });
    totalTokens += tokens;
  }

  return {
    requestTimestamps: finiteNumbers(raw.requestTimestamps, now, MINUTE),
    tokenTimestamps: capped.reverse(),
    dayTimestamps: finiteNumbers(raw.dayTimestamps, now, DAY),
  };
}

function hasUsage(usage: Usage): boolean {
  return (
    usage.requestTimestamps.length > 0 ||
    usage.tokenTimestamps.length > 0 ||
    usage.dayTimestamps.length > 0
  );
}

export class RateLimiter {
  private usage = new Map<TierName, Usage>();
  private unavailableUntil = new Map<TierName, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private loaded: Promise<void>;

  constructor(private readonly stateFile: string = DEFAULT_STATE_FILE) {
    this.loaded = this.load();
  }

  private async load() {
    try {
      const file = Bun.file(this.stateFile);
      if (await file.exists()) {
        const data = (await file.json()) as Record<string, unknown>;
        const now = Date.now();
        for (const [tier, raw] of Object.entries(data)) {
          if (!VALID_TIERS.includes(tier as TierName)) continue;
          const usage = normalizeUsage(raw, now);
          if (hasUsage(usage)) this.usage.set(tier as TierName, usage);
        }
      }
      await this.saveImmediately();
    } catch (err) {
      log.warn(`[rateLimiter] couldn't load ${this.stateFile}, starting fresh:`, err);
    }
  }

  /** Atomically replace the state file so readers never see a partial write. */
  async saveImmediately(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const snapshot = Object.fromEntries(this.usage.entries());
    const operation = this.saveChain.then(async () => {
      const tempFile = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(this.stateFile), { recursive: true });
        await Bun.write(tempFile, JSON.stringify(snapshot, null, 2));
        await rename(tempFile, this.stateFile);
      } catch (err) {
        log.warn(`[rateLimiter] couldn't save ${this.stateFile}:`, err);
        await rm(tempFile, { force: true }).catch(() => undefined);
      }
    });

    this.saveChain = operation;
    await operation;
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveImmediately();
    }, 500);
  }

  private getUsage(tier: TierName): Usage {
    let usage = this.usage.get(tier);
    if (!usage) {
      usage = emptyUsage();
      this.usage.set(tier, usage);
    }
    return usage;
  }

  private prune(usage: Usage, now: number) {
    usage.requestTimestamps = usage.requestTimestamps.filter((t) => now - t < MINUTE);
    usage.tokenTimestamps = usage.tokenTimestamps.filter((t) => now - t.at < MINUTE);
    usage.dayTimestamps = usage.dayTimestamps.filter((t) => now - t < DAY);
  }

  private cleanupIfEmpty(tier: TierName, usage: Usage) {
    if (!hasUsage(usage)) {
      this.usage.delete(tier);
    }
  }

  canServe(tier: TierName, limits: TierLimits, estimatedTokens: number): boolean {
    const now = Date.now();
    const unavailableUntil = this.unavailableUntil.get(tier) ?? 0;
    if (unavailableUntil > now) {
      log.warn(
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
      log.warn(`[rateLimiter] ${tier} skip: rate limit reached`, JSON.stringify(snapshot));
    }

    this.cleanupIfEmpty(tier, usage);
    return canServe;
  }

  record(tier: TierName, tokensUsed: number) {
    const now = Date.now();
    const tokens = Number.isFinite(tokensUsed) && tokensUsed > 0 ? Math.floor(tokensUsed) : 0;
    const usage = this.getUsage(tier);
    usage.requestTimestamps.push(now);
    usage.dayTimestamps.push(now);
    usage.tokenTimestamps.push({ at: now, tokens });
    this.scheduleSave();
  }

  markUnavailable(tier: TierName, durationMs: number) {
    this.unavailableUntil.set(tier, Date.now() + durationMs);
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
  const record = err !== null && typeof err === "object" ? err : undefined;

  if (record && "headers" in record && record.headers instanceof Headers) {
    const headerRetry = retryAfterFromHeaders(record.headers);
    if (headerRetry !== undefined) return headerRetry;
  }
  if (record && "retryAfterMs" in record && typeof record.retryAfterMs === "number") {
    return record.retryAfterMs;
  }

  const message = err instanceof Error ? err.message : String(err);
  const status = record && "status" in record ? record.status : undefined;
  const isRateLimitSignal =
    /resource has been exhausted|resource_exhausted|quota exceeded|quota|exhausted|rate limit|too many requests|rate_limit_exceeded|tokens per minute|tpm.*limit|limit .* requested .* try again|out of credit|credit limit|overloaded/i.test(
      message,
    ) ||
    status === 429 ||
    status === 413 ||
    status === 503;

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
