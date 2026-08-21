import { cerebrasAdapter } from "./adapters/cerebras";
import { cloudflareAdapter } from "./adapters/cloudflare";
import { cohereAdapter } from "./adapters/cohere";
import { geminiAdapter } from "./adapters/gemini";
import { groqAdapter } from "./adapters/groq";
import { localAdapter } from "./adapters/local";
import { mistralAdapter } from "./adapters/mistral";
import { nvidiaAdapter } from "./adapters/nvidia";
import { openrouterAdapter } from "./adapters/openrouter";
import { cacheKey, setCached } from "./cache";
import { config } from "./config";
import { POLICIES } from "./policies";
import { pruneNormalizedRequest } from "./pruner";
import { rateLimiter } from "./rateLimiter";
import { resolvers } from "./resolvers";
import { AnthropicSSEWriter } from "./streaming/anthropicSSE";
import { reconstructingStream } from "./streaming/reconstruct";
import { countTokens } from "./tokenizer";
import type { NormalizedRequest, ProviderAdapter, ResolvedBy, TierName } from "./types";

const adapters: Record<TierName, ProviderAdapter> = {
  cerebras: cerebrasAdapter,
  groq: groqAdapter,
  gemini: geminiAdapter,
  openrouter: openrouterAdapter,
  mistral: mistralAdapter,
  nvidia: nvidiaAdapter,
  cloudflare: cloudflareAdapter,
  cohere: cohereAdapter,
  local: localAdapter,
};

const limitsByTier: Record<TierName, { rpm: number; tpm: number; rpd: number }> = {
  cerebras: config.cerebras.limits,
  groq: config.groq.limits,
  gemini: config.gemini.limits,
  openrouter: config.openrouter.limits,
  mistral: config.mistral.limits,
  nvidia: config.nvidia.limits,
  cloudflare: config.cloudflare.limits,
  cohere: config.cohere.limits,
  local: config.local.limits,
};

/** Token estimate via cl100k_base tokenizer. */
export function estimateTokens(req: NormalizedRequest): number {
  let text = req.systemPrompt ?? "";
  for (const m of req.messages) {
    text += `\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
  }
  text += JSON.stringify(req.tools);
  return countTokens(text);
}

/**
 * Decide the ordered list of tiers to try for this request.
 *
 * Heuristics:
 * - Large context (>4k input tokens) → prefer Gemini Flash first (huge TPM budget).
 * - Otherwise walk configured fallbackOrder.
 * - Local is the last resort unless explicitly forced private.
 */
export function planTierOrder(
  _req: NormalizedRequest,
  estimatedInputTokens: number,
  opts?: { forcePrivate?: boolean },
): TierName[] {
  if (opts?.forcePrivate) return ["local"];

  let baseOrder: TierName[];

  if (config.hasCustomFallbackOrder) {
    baseOrder = [...config.fallbackOrder];
  } else if (estimatedInputTokens > 4000) {
    baseOrder = [
      "gemini",
      "mistral",
      "cerebras",
      "openrouter",
      "groq",
      "nvidia",
      "cloudflare",
      "cohere",
      "local",
    ];
  } else {
    baseOrder = [...config.fallbackOrder];
  }

  return baseOrder;
}

export interface RouteResult {
  tierUsed: ResolvedBy;
  response: Awaited<ReturnType<ProviderAdapter["send"]>>;
  attempts: { tier: TierName; skipped?: string; error?: string }[];
  policyApplied?: string;
}

export async function routeRequest(
  req: NormalizedRequest,
  opts?: { forcePrivate?: boolean },
): Promise<RouteResult> {
  const rule = POLICIES.find((r) => r.match(req));

  // Deterministic strategy: try to resolve without touching any model.
  if (rule?.strategy.kind === "deterministic") {
    const resolver = resolvers[rule.strategy.resolver];
    if (!resolver) {
      throw new Error(
        `Policy "${rule.name}" references unknown resolver "${rule.strategy.resolver}"`,
      );
    }
    const resolved = await resolver(req);
    if (resolved) {
      return {
        tierUsed: "deterministic",
        response: resolved,
        attempts: [],
        policyApplied: rule.name,
      };
    }
  }

  const estimated = estimateTokens(req);
  let order = planTierOrder(req, estimated, opts);

  if (rule?.strategy.kind === "tier") {
    const forcedTier = rule.strategy.tier;
    order = [forcedTier, ...order.filter((t) => t !== forcedTier)];
  } else if (rule?.strategy.kind === "local") {
    order = ["local", ...order.filter((t) => t !== "local")];
  }

  const attempts: RouteResult["attempts"] = [];

  for (const tier of order) {
    const adapter = adapters[tier];
    const limits = limitsByTier[tier];

    const hasKey = hasCredentials(tier);
    if (!hasKey) {
      console.warn(`[router] skip ${tier}: no API key/token configured`);
      attempts.push({ tier, skipped: "no API key/token configured" });
      continue;
    }
    let effectiveReq = req;
    let effectiveTokens = estimated;
    if (limits.tpm > 0 && estimated > limits.tpm) {
      effectiveReq = pruneNormalizedRequest(req, limits.tpm);
      effectiveTokens = estimateTokens(effectiveReq);
    }

    if (limits.tpm > 0 && effectiveTokens > limits.tpm) {
      console.warn(
        `[router] skip ${tier}: effective request size (${effectiveTokens} tokens) exceeds TPM limit (${limits.tpm})`,
      );
      attempts.push({
        tier,
        skipped: `effective request size (${effectiveTokens} tokens) exceeds TPM limit (${limits.tpm})`,
      });
      continue;
    }

    if (!adapter.canHandle(effectiveReq, effectiveTokens)) {
      console.warn(`[router] skip ${tier}: request doesn't fit this tier (context/size)`);
      attempts.push({ tier, skipped: "request doesn't fit this tier (context/size)" });
      continue;
    }
    if (!rateLimiter.canServe(tier, limits, effectiveTokens)) {
      console.warn(`[router] skip ${tier}: rate limit reached`);
      attempts.push({ tier, skipped: "rate limit reached" });
      continue;
    }

    try {
      console.log(`[router] trying ${tier}...`);
      if (effectiveTokens < estimated) {
        console.log(
          `[router] pruned request for ${tier} from ${estimated} to ${effectiveTokens} tokens`,
        );
      }
      const response = await adapter.send(effectiveReq);
      const totalTokens = response.usage.input_tokens + response.usage.output_tokens || estimated;
      rateLimiter.record(tier, totalTokens);
      const key = await cacheKey(req);
      setCached(key, response);
      console.log(`[router] success via ${tier}`);
      return { tierUsed: tier, response, attempts, policyApplied: rule?.name };
    } catch (err: any) {
      console.warn(`[router] fail ${tier}: ${err.message ?? String(err)}`);
      const retryAfterMs = retryAfterFromError(err);
      if (retryAfterMs !== undefined) {
        rateLimiter.markUnavailable(tier, retryAfterMs);
      }
      attempts.push({ tier, error: err.message ?? String(err) });
    }
  }

  throw new Error(`All tiers exhausted or unavailable: ${JSON.stringify(attempts, null, 2)}`);
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
    /quota exceeded|rate limit|too many requests|rate_limit_exceeded|tokens per minute|tpm.*limit|limit .* requested .* try again/i.test(
      message,
    );
  if (!isRateLimitSignal) return undefined;

  const match = message.match(/retry in\s+([\d.]+)\s*(ms|s|m)?/i);
  if (!match) return 60_000;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 60_000;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "m" ? 60_000 : 1_000;
  return Math.max(1_000, Math.ceil(amount * multiplier));
}

function hasCredentials(tier: TierName): boolean {
  switch (tier) {
    case "cerebras":
      return Boolean(config.cerebras.apiKey);
    case "groq":
      return Boolean(config.groq.apiKey);
    case "gemini":
      return Boolean(config.gemini.apiKey);
    case "openrouter":
      return Boolean(config.openrouter.apiKey);
    case "mistral":
      return Boolean(config.mistral.apiKey);
    case "nvidia":
      return Boolean(config.nvidia.apiKey);
    case "cloudflare":
      return Boolean(config.cloudflare.apiToken && config.cloudflare.accountId);
    case "cohere":
      return Boolean(config.cohere.apiKey);
    case "local":
      return true;
  }
}

export interface StreamRouteResult {
  tierUsed: ResolvedBy;
  stream: ReadableStream<Uint8Array>;
  policyApplied?: string;
}

export async function routeRequestStream(
  req: NormalizedRequest,
  opts?: { forcePrivate?: boolean },
): Promise<StreamRouteResult> {
  const rule = POLICIES.find((r) => r.match(req));

  if (rule?.strategy.kind === "deterministic") {
    const resolver = resolvers[rule.strategy.resolver];
    if (!resolver) {
      throw new Error(
        `Policy "${rule.name}" references unknown resolver "${rule.strategy.resolver}"`,
      );
    }
    const resolved = await resolver(req);
    if (resolved) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          AnthropicSSEWriter.fromResponse(resolved, controller);
        },
      });
      return { tierUsed: "deterministic", stream, policyApplied: rule.name };
    }
  }

  const estimated = estimateTokens(req);
  let order = planTierOrder(req, estimated, opts);
  if (rule?.strategy.kind === "tier") {
    const forcedTier = rule.strategy.tier;
    order = [forcedTier, ...order.filter((t) => t !== forcedTier)];
  } else if (rule?.strategy.kind === "local") {
    order = ["local", ...order.filter((t) => t !== "local")];
  }

  for (const tier of order) {
    const adapter = adapters[tier];
    const limits = limitsByTier[tier];
    if (!hasCredentials(tier)) continue;
    if (!adapter.sendStream) continue;
    let effectiveReq = req;
    let effectiveTokens = estimated;
    if (limits.tpm > 0 && estimated > limits.tpm) {
      effectiveReq = pruneNormalizedRequest(req, limits.tpm);
      effectiveTokens = estimateTokens(effectiveReq);
    }

    if (limits.tpm > 0 && effectiveTokens > limits.tpm) {
      console.warn(
        `[router] skip streaming ${tier}: effective request size (${effectiveTokens} tokens) exceeds TPM limit (${limits.tpm})`,
      );
      continue;
    }

    if (!adapter.canHandle(effectiveReq, effectiveTokens)) continue;
    if (!rateLimiter.canServe(tier, limits, effectiveTokens)) continue;

    rateLimiter.record(tier, effectiveTokens);

    if (effectiveTokens < estimated) {
      console.log(
        `[router] pruned stream request for ${tier} from ${estimated} to ${effectiveTokens} tokens`,
      );
    }

    const rawStream = adapter.sendStream(effectiveReq);
    const stream = reconstructingStream(rawStream, async (response) => {
      const key = await cacheKey(req);
      setCached(key, response);
    });
    return { tierUsed: tier, stream, policyApplied: rule?.name };
  }

  throw new Error(
    "No tier available for streaming — check API keys, rate limits, and that the local server is reachable.",
  );
}
