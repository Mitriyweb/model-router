import { cacheKey, setCached } from "../cache";
import { AllTiersFailedError, type RouteAttempt, errorMessage } from "../errors";
import { log } from "../log";
import { rateLimiter, retryAfterFromError } from "../rateLimiter";
export { retryAfterFromError, retryAfterFromHeaders } from "../rateLimiter";
import { resolvers } from "../resolvers";
import { AnthropicSSEWriter } from "../streaming/anthropicSSE";
import { reconstructingStream } from "../streaming/reconstruct";
import { estimateRequestTokens } from "../tokenizer";
import type {
  AnthropicResponse,
  NormalizedRequest,
  ProviderAdapter,
  ResolvedBy,
  TierName,
} from "../types";
import { type AttemptContext, prepareAttempt } from "./attempt";
import { type RouteOptions, type RoutePlan, deterministicRule, planRoute } from "./planner";

export { estimateRequestTokens as estimateTokens };

interface TierLoopResult<T> {
  tierUsed: TierName;
  value: T;
  attempts: RouteAttempt[];
  policyApplied?: string;
}

/**
 * Walk the planned tier order, running every pre-flight check in one place.
 *
 * Both the unary and streaming pipelines call this with a different sink, so
 * skip reasons and per-tier diagnostics are identical between the two.
 */
async function executeTiers<T>(
  plan: RoutePlan,
  req: NormalizedRequest,
  run: (attempt: AttemptContext) => Promise<T> | T,
  opts?: { requireStream?: boolean },
): Promise<TierLoopResult<T>> {
  const attempts: RouteAttempt[] = [];

  for (const tier of plan.order) {
    const preparation = prepareAttempt(tier, req, plan.estimatedTokens, {
      requireStream: opts?.requireStream,
    });

    if (preparation.kind === "skip") {
      log.warn(`[router] skip ${tier}: ${preparation.reason}`);
      attempts.push({ tier, skipped: preparation.reason });
      continue;
    }

    const { attempt } = preparation;

    try {
      log.info(`[router] trying ${tier}...`);
      if (attempt.prunedFrom !== undefined) {
        log.info(
          `[router] pruned request for ${tier} from ${attempt.prunedFrom} to ${attempt.estimatedTokens} tokens`,
        );
      }

      const value = await run(attempt);
      log.info(`[router] success via ${tier}`);
      return { tierUsed: tier, value, attempts, policyApplied: plan.rule?.name };
    } catch (err) {
      const message = errorMessage(err);
      log.warn(`[router] fail ${tier}: ${message}`);
      const retryAfterMs = retryAfterFromError(err);
      if (retryAfterMs !== undefined) {
        rateLimiter.markUnavailable(tier, retryAfterMs);
      }
      attempts.push({ tier, error: message });
    }
  }

  throw new AllTiersFailedError(attempts);
}

async function resolveDeterministic(
  rule: NonNullable<RoutePlan["rule"]>,
  req: NormalizedRequest,
): Promise<AnthropicResponse | null> {
  if (rule.strategy.kind !== "deterministic") return null;

  const resolver = resolvers[rule.strategy.resolver];
  if (!resolver) {
    throw new Error(
      `Policy "${rule.name}" references unknown resolver "${rule.strategy.resolver}"`,
    );
  }
  return resolver(req);
}

export interface RouteResult {
  tierUsed: ResolvedBy;
  response: Awaited<ReturnType<ProviderAdapter["send"]>>;
  attempts: RouteAttempt[];
  policyApplied?: string;
}

export async function routeRequest(
  req: NormalizedRequest,
  opts?: RouteOptions,
): Promise<RouteResult> {
  const plan = planRoute(req, opts);
  const rule = deterministicRule(plan, opts);

  if (rule) {
    const resolved = await resolveDeterministic(rule, req);
    if (resolved) {
      return {
        tierUsed: "deterministic",
        response: resolved,
        attempts: [],
        policyApplied: rule.name,
      };
    }
  }

  const result = await executeTiers(plan, req, async (attempt) => {
    const response = await attempt.adapter.send(attempt.request);
    const totalTokens =
      response.usage.input_tokens + response.usage.output_tokens || plan.estimatedTokens;
    rateLimiter.record(attempt.tier, totalTokens);

    const key = await cacheKey(req);
    setCached(key, response);
    return response;
  });

  return {
    tierUsed: result.tierUsed,
    response: result.value,
    attempts: result.attempts,
    policyApplied: result.policyApplied,
  };
}

export interface StreamRouteResult {
  tierUsed: ResolvedBy;
  stream: ReadableStream<Uint8Array>;
  attempts: RouteAttempt[];
  policyApplied?: string;
}

export async function routeRequestStream(
  req: NormalizedRequest,
  opts?: RouteOptions,
): Promise<StreamRouteResult> {
  const plan = planRoute(req, opts);
  const rule = deterministicRule(plan, opts);

  if (rule) {
    const resolved = await resolveDeterministic(rule, req);
    if (resolved) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          AnthropicSSEWriter.fromResponse(resolved, controller);
        },
      });
      return { tierUsed: "deterministic", stream, attempts: [], policyApplied: rule.name };
    }
  }

  const result = await executeTiers(
    plan,
    req,
    (attempt) => {
      const rawStream = attempt.adapter.sendStream!(attempt.request);
      return reconstructingStream(rawStream, async (response) => {
        const totalTokens = response.usage.input_tokens + response.usage.output_tokens;
        rateLimiter.record(attempt.tier, totalTokens || attempt.budgetTokens);

        const key = await cacheKey(req);
        setCached(key, response);
      });
    },
    { requireStream: true },
  );

  return {
    tierUsed: result.tierUsed,
    stream: result.value,
    attempts: result.attempts,
    policyApplied: result.policyApplied,
  };
}
