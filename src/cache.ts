import { config } from "./config";
import type { AnthropicResponse, NormalizedRequest } from "./types";

interface CacheEntry {
  response: AnthropicResponse;
  expiresAt: number;
  lastUsed: number;
}

export interface CacheStats {
  entries: number;
  maxEntries: number;
  ttlMs: number;
  hits: number;
  misses: number;
  evictions: number;
  expired: number;
}

export interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Small in-memory LRU cache with TTL and observability counters. */
export class ResponseCache {
  private entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expired = 0;

  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? config.cacheTtlMs;
    this.maxEntries = options.maxEntries ?? config.cacheMaxEntries;
    this.now = options.now ?? Date.now;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.expired += 1;
      }
    }
  }

  get(key: string): AnthropicResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.expired += 1;
      this.misses += 1;
      return undefined;
    }

    entry.lastUsed = this.now();
    this.hits += 1;
    return entry.response;
  }

  set(key: string, response: AnthropicResponse): void {
    this.pruneExpired();
    this.entries.delete(key);

    while (this.entries.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidate, entry] of this.entries) {
        if (entry.lastUsed < oldestAt) {
          oldestKey = candidate;
          oldestAt = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }

    const now = this.now();
    this.entries.set(key, { response, expiresAt: now + this.ttlMs, lastUsed: now });
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expired = 0;
  }

  stats(): CacheStats {
    this.pruneExpired();
    return {
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expired: this.expired,
    };
  }
}

/**
 * Cache key includes every request field that can change the model's answer
 * (model, sampling, output budget and tools) in addition to the prompt itself.
 */
export async function cacheKey(req: NormalizedRequest): Promise<string> {
  const payload = JSON.stringify({
    model: req.model ?? null,
    systemPrompt: req.systemPrompt,
    messages: req.messages,
    tools: req.tools,
    temperature: req.temperature ?? null,
    maxTokens: req.maxTokens ?? null,
  });

  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const responseCache = new ResponseCache();

export function getCached(key: string): AnthropicResponse | undefined {
  return responseCache.get(key);
}

export function setCached(key: string, response: AnthropicResponse): void {
  responseCache.set(key, response);
}

export function clearCache(): void {
  responseCache.clear();
}

export function cacheStats(): CacheStats {
  return responseCache.stats();
}
