import { config } from "../config";
import { POLICIES } from "../policies";
import { estimateRequestTokens } from "../tokenizer";
import type { NormalizedRequest, PolicyRule, TierName } from "../types";

export interface RouteOptions {
  forcePrivate?: boolean;
  forceTier?: TierName;
}

export interface RoutePlan {
  rule?: PolicyRule;
  order: TierName[];
  estimatedTokens: number;
}

/**
 * Preferred order for large contexts: Gemini Flash first for its TPM budget,
 * then Mistral for its large free quota, then the usual order.
 */
const LARGE_CONTEXT_ORDER: TierName[] = [
  "gemini",
  "mistral",
  "cerebras",
  "openrouter",
  "groq",
  "nvidia",
  "huggingface",
  "cloudflare",
  "cohere",
  "local",
];

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
  opts?: RouteOptions,
): TierName[] {
  if (opts?.forceTier) return [opts.forceTier];
  if (opts?.forcePrivate) return ["local"];

  if (config.hasCustomFallbackOrder) return [...config.fallbackOrder];
  if (estimatedInputTokens > 4000) return [...LARGE_CONTEXT_ORDER];
  return [...config.fallbackOrder];
}

/**
 * Match policies, estimate the request and return the final tier order.
 *
 * Pure with respect to `req`: it only reads the mutable `config` singleton.
 */
export function planRoute(req: NormalizedRequest, opts?: RouteOptions): RoutePlan {
  const rule = POLICIES.find((candidate) => candidate.match(req));
  const estimatedTokens = estimateRequestTokens(req);

  let order = planTierOrder(req, estimatedTokens, opts);

  if (opts?.forceTier) {
    order = [opts.forceTier];
  } else if (rule?.strategy.kind === "tier") {
    const forcedTier = rule.strategy.tier;
    order = [forcedTier, ...order.filter((tier) => tier !== forcedTier)];
  } else if (rule?.strategy.kind === "local") {
    order = ["local", ...order.filter((tier) => tier !== "local")];
  }

  return { rule, order, estimatedTokens };
}

/** The deterministic rule to resolve before walking tiers, unless a tier is forced. */
export function deterministicRule(plan: RoutePlan, opts?: RouteOptions): PolicyRule | undefined {
  if (opts?.forceTier) return undefined;
  return plan.rule?.strategy.kind === "deterministic" ? plan.rule : undefined;
}
