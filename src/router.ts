import { cerebrasAdapter } from "./adapters/cerebras";
import { cloudflareAdapter } from "./adapters/cloudflare";
import { cohereAdapter } from "./adapters/cohere";
import { geminiAdapter } from "./adapters/gemini";
import { githubAdapter } from "./adapters/github";
import { groqAdapter } from "./adapters/groq";
import { localAdapter } from "./adapters/local";
import { mistralAdapter } from "./adapters/mistral";
import { nvidiaAdapter } from "./adapters/nvidia";
import { openrouterAdapter } from "./adapters/openrouter";
import { cacheKey, setCached } from "./cache";
import { config } from "./config";
import { POLICIES } from "./policies";
import { rateLimiter } from "./rateLimiter";
import { resolvers } from "./resolvers";
import { AnthropicSSEWriter } from "./streaming/anthropicSSE";
import { reconstructingStream } from "./streaming/reconstruct";
import { countTokens } from "./tokenizer";
import type { NormalizedRequest, ProviderAdapter, ResolvedBy, TierName } from "./types";

const adapters: Record<TierName, ProviderAdapter> = {
  github: githubAdapter,
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
  github: config.github.limits,
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

  if (config.hasCustomFallbackOrder) {
    return [...config.fallbackOrder];
  }

  if (estimatedInputTokens > 4000) {
    return [
      "gemini",
      "github",
      "mistral",
      "cerebras",
      "openrouter",
      "groq",
      "nvidia",
      "cloudflare",
      "cohere",
      "local",
    ];
  }

  return [...config.fallbackOrder];
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
    if (!adapter.canHandle(req, estimated)) {
      console.warn(`[router] skip ${tier}: request doesn't fit this tier (context/size)`);
      attempts.push({ tier, skipped: "request doesn't fit this tier (context/size)" });
      continue;
    }
    if (!rateLimiter.canServe(tier, limits, estimated)) {
      console.warn(`[router] skip ${tier}: rate limit reached`);
      attempts.push({ tier, skipped: "rate limit reached" });
      continue;
    }

    try {
      console.log(`[router] trying ${tier}...`);
      const response = await adapter.send(req);
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

function retryAfterFromError(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (!/quota exceeded|rate limit|too many requests/i.test(message)) return undefined;

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
    case "github":
      return Boolean(config.github.token);
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
    if (!adapter.canHandle(req, estimated)) continue;
    if (!rateLimiter.canServe(tier, limits, estimated)) continue;

    rateLimiter.record(tier, estimated);

    const rawStream = adapter.sendStream(req);
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
