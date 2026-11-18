import { config } from "../config";
import { adapters, hasCredentials } from "../providers";
import { pruneNormalizedRequest } from "../pruner";
import { rateLimiter } from "../rateLimiter";
import { estimateRequestTokens } from "../tokenizer";
import type { NormalizedRequest, ProviderAdapter, TierLimits, TierName } from "../types";

export interface AttemptContext {
  tier: TierName;
  adapter: ProviderAdapter;
  limits: TierLimits;
  /** Request after pruning, ready to hand to the adapter. */
  request: NormalizedRequest;
  /** Estimated input tokens of `request`. */
  estimatedTokens: number;
  /** Estimated input + requested output tokens used for TPM budgeting. */
  budgetTokens: number;
  /** Original input estimate when `request` was pruned. */
  prunedFrom?: number;
}

export type AttemptPreparation =
  | { kind: "ready"; attempt: AttemptContext }
  | { kind: "skip"; reason: string };

function targetInputLimit(limits: TierLimits, requestedOutputTokens: number): number {
  if (limits.tpm <= 0) return config.routerMaxContextTokens;
  return Math.min(Math.max(limits.tpm - requestedOutputTokens, 1), config.routerMaxContextTokens);
}

/**
 * Run every pre-flight check for one tier: credentials, streaming support,
 * context pruning, TPM budget, adapter capability and rate limits.
 *
 * Returns either a ready-to-send attempt or a human-readable skip reason, so
 * both the send and stream pipelines produce identical diagnostics.
 */
export function prepareAttempt(
  tier: TierName,
  req: NormalizedRequest,
  estimatedTokens: number,
  opts?: { requireStream?: boolean },
): AttemptPreparation {
  const adapter = adapters[tier];
  const limits = config[tier].limits;

  if (!hasCredentials(tier)) {
    return { kind: "skip", reason: "no API key/token configured" };
  }
  if (opts?.requireStream && !adapter.sendStream) {
    return { kind: "skip", reason: "streaming not supported" };
  }

  const requestedOutputTokens = req.maxTokens ?? 0;
  const targetLimit = targetInputLimit(limits, requestedOutputTokens);

  let request = req;
  let effectiveTokens = estimatedTokens;
  if (estimatedTokens > targetLimit) {
    request = pruneNormalizedRequest(req, targetLimit);
    effectiveTokens = estimateRequestTokens(request);
  }

  const budgetTokens = effectiveTokens + requestedOutputTokens;
  if (limits.tpm > 0 && budgetTokens > limits.tpm) {
    return {
      kind: "skip",
      reason: `effective request budget (${budgetTokens} tokens) exceeds TPM limit (${limits.tpm})`,
    };
  }

  if (!adapter.canHandle(request, effectiveTokens)) {
    return { kind: "skip", reason: "request doesn't fit this tier (context/size)" };
  }

  if (!rateLimiter.canServe(tier, limits, budgetTokens)) {
    return { kind: "skip", reason: "rate limit reached" };
  }

  return {
    kind: "ready",
    attempt: {
      tier,
      adapter,
      limits,
      request,
      estimatedTokens: effectiveTokens,
      budgetTokens,
      prunedFrom: effectiveTokens < estimatedTokens ? estimatedTokens : undefined,
    },
  };
}
