import { anthropicResponseToOpenAI, openAIRequestToNormalized } from "../adapters/openaiCompatible";
import { cacheStats } from "../cache";
import { config } from "../config";
import { log } from "../log";
import { VALID_TIERS, hasCredentials } from "../providers";
import { rateLimiter } from "../rateLimiter";
import { routeRequest, routeRequestStream } from "../router";
import { anthropicStreamToOpenAI } from "../streaming/openaiSSE";
import type { AnthropicRequest, NormalizedRequest, TierName } from "../types";
import {
  HttpError,
  type RequestContext,
  errorResponse,
  isResetAuthorized,
  jsonResponse,
  readJsonBody,
  withContextHeaders,
} from "./http";

export function isValidTier(tier?: string | null): tier is TierName {
  if (!tier) return false;
  return VALID_TIERS.includes(tier.toLowerCase() as TierName);
}

function parseTierHeader(ctx: RequestContext): TierName | undefined {
  const header =
    ctx.request.headers.get("x-router-provider") || ctx.request.headers.get("x-router-tier");
  return isValidTier(header) ? (header.toLowerCase() as TierName) : undefined;
}

export function parseModelTierOverride(modelName?: string): {
  tier?: TierName;
  cleanModel?: string;
} {
  if (!modelName || modelName === "model-router-auto") {
    return { cleanModel: undefined };
  }

  for (const tier of VALID_TIERS) {
    if (modelName === tier) return { tier, cleanModel: undefined };
    if (modelName.startsWith(`${tier}/`)) {
      const clean = modelName.slice(tier.length + 1);
      return { tier, cleanModel: clean || undefined };
    }
  }

  return { cleanModel: modelName };
}

function normalize(req: AnthropicRequest): NormalizedRequest {
  const systemPrompt =
    typeof req.system === "string" ? req.system : (req.system ?? []).map((s) => s.text).join("\n");

  return {
    systemPrompt,
    messages: req.messages ?? [],
    tools: req.tools ?? [],
    maxTokens: req.max_tokens,
    temperature: req.temperature,
    stream: req.stream ?? false,
  };
}

function tierFailure(err: unknown): HttpError {
  const message = err instanceof Error ? err.message : String(err);
  return new HttpError(502, message, "all_tiers_exhausted");
}

async function handleStreamingMessages(
  ctx: RequestContext,
  normalized: NormalizedRequest,
  forcePrivate: boolean,
  forceTier?: TierName,
): Promise<Response> {
  try {
    const result = await routeRequestStream(normalized, { forcePrivate, forceTier });
    ctx.tier = result.tierUsed;
    const policyStr = result.policyApplied ? ` [policy: ${result.policyApplied}]` : "";
    log.info(`[router] streaming via ${result.tierUsed}${policyStr}`);
    return withContextHeaders(
      new Response(result.stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "x-router-tier": result.tierUsed,
        },
      }),
      ctx,
    );
  } catch (err) {
    log.error("[router] streaming setup failed:", String(err));
    return errorResponse(tierFailure(err), ctx);
  }
}

export async function handleMessages(ctx: RequestContext, forceTier?: TierName): Promise<Response> {
  ctx.format = "anthropic";
  try {
    const body = await readJsonBody<AnthropicRequest>(ctx.request, ctx.format);
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "invalid JSON body");
    }

    const targetTier = forceTier ?? parseTierHeader(ctx);
    const forcePrivate = ctx.request.headers.get("x-router-private") === "true";
    const normalized = normalize(body);

    if (normalized.stream) {
      return handleStreamingMessages(ctx, normalized, forcePrivate, targetTier);
    }

    const result = await routeRequest(normalized, { forcePrivate, forceTier: targetTier });
    ctx.tier = result.tierUsed;
    const policyStr = result.policyApplied ? ` [policy: ${result.policyApplied}]` : "";
    const skippedStr = result.attempts.length
      ? ` (skipped: ${result.attempts.map((a) => a.tier).join(", ")})`
      : "";
    log.info(`[router] served via ${result.tierUsed}${policyStr}${skippedStr}`);
    return jsonResponse(result.response, ctx, 200);
  } catch (err) {
    if (err instanceof HttpError) {
      log.warn(`[http] ${err.status}: ${err.message}`);
    } else {
      log.error("[router] all tiers failed:", String(err));
    }
    return errorResponse(err instanceof HttpError ? err : tierFailure(err), ctx);
  }
}

export async function handleChatCompletions(
  ctx: RequestContext,
  forceTier?: TierName,
): Promise<Response> {
  ctx.format = "openai";
  try {
    const body = await readJsonBody<Record<string, any>>(ctx.request, ctx.format);
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
      throw new HttpError(400, "Invalid JSON body");
    }

    const requestedModel = body.model as string | undefined;
    const { tier: tierOverride, cleanModel } = parseModelTierOverride(requestedModel);
    const headerTier = parseTierHeader(ctx);
    const targetTier = forceTier ?? headerTier ?? tierOverride;

    const isLocalModel = requestedModel === "local" || requestedModel?.startsWith("local/");
    const forcePrivate =
      ctx.request.headers.get("x-router-private") === "true" || Boolean(isLocalModel);
    const normalized = openAIRequestToNormalized(body, cleanModel);

    if (normalized.stream) {
      try {
        const result = await routeRequestStream(normalized, {
          forcePrivate,
          forceTier: targetTier,
        });
        ctx.tier = result.tierUsed;
        const openAIStream = anthropicStreamToOpenAI(result.stream, requestedModel);
        log.info(`[router/openai] streaming via ${result.tierUsed} [model: ${requestedModel}]`);
        return withContextHeaders(
          new Response(openAIStream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "x-router-tier": result.tierUsed,
            },
          }),
          ctx,
        );
      } catch (err) {
        log.error("[router/openai] streaming setup failed:", String(err));
        return errorResponse(tierFailure(err), ctx);
      }
    }

    const result = await routeRequest(normalized, { forcePrivate, forceTier: targetTier });
    ctx.tier = result.tierUsed;
    log.info(`[router/openai] served via ${result.tierUsed} [model: ${requestedModel}]`);
    return jsonResponse(anthropicResponseToOpenAI(result.response, requestedModel), ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      log.warn(`[http/openai] ${err.status}: ${err.message}`);
    } else {
      log.error("[router/openai] request failed:", String(err));
    }
    return errorResponse(err instanceof HttpError ? err : tierFailure(err), ctx);
  }
}

export function handleModels(ctx: RequestContext): Response {
  const modelsMap = new Map<
    string,
    { id: string; object: string; created: number; owned_by: string; configured: boolean }
  >();

  modelsMap.set("model-router-auto", {
    id: "model-router-auto",
    object: "model",
    created: 1700000000,
    owned_by: "model-router",
    configured: true,
  });

  for (const tier of VALID_TIERS) {
    const tierConfig = config[tier];
    const configured = hasCredentials(tier);
    const defaultModel = tierConfig.model;

    modelsMap.set(tier, {
      id: tier,
      object: "model",
      created: 1700000000,
      owned_by: tier,
      configured,
    });

    if (defaultModel) {
      modelsMap.set(defaultModel, {
        id: defaultModel,
        object: "model",
        created: 1700000000,
        owned_by: tier,
        configured,
      });

      const prefixedModel = `${tier}/${defaultModel}`;
      modelsMap.set(prefixedModel, {
        id: prefixedModel,
        object: "model",
        created: 1700000000,
        owned_by: tier,
        configured,
      });
    }
  }

  const knownExtraModels: { id: string; owned_by: TierName }[] = [
    { id: "mistral-large-latest", owned_by: "mistral" },
  ];
  for (const extra of knownExtraModels) {
    modelsMap.set(extra.id, {
      id: extra.id,
      object: "model",
      created: 1700000000,
      owned_by: extra.owned_by,
      configured: hasCredentials(extra.owned_by),
    });
  }

  return jsonResponse({ object: "list", data: Array.from(modelsMap.values()) }, ctx);
}

export function handleProviders(ctx: RequestContext): Response {
  const providers = VALID_TIERS.map((tier) => {
    const tierConfig = config[tier];
    return {
      id: tier,
      name: tier,
      configured: hasCredentials(tier),
      model: tierConfig.model,
      limits: tierConfig.limits,
      status: rateLimiter.snapshot(tier, tierConfig.limits),
    };
  });

  return jsonResponse({ object: "list", data: providers }, ctx);
}

export function handleStatus(ctx: RequestContext): Response {
  const snapshot = Object.fromEntries(
    VALID_TIERS.map((tier) => [tier, rateLimiter.snapshot(tier, config[tier].limits)]),
  );
  return jsonResponse({ status: "ok", tiers: snapshot, cache: cacheStats() }, ctx);
}

export function handleHealth(ctx: RequestContext): Response {
  return jsonResponse({ status: "ok" }, ctx);
}

export async function handleReset(ctx: RequestContext): Promise<Response> {
  if (!isResetAuthorized(ctx.request)) {
    return errorResponse(new HttpError(401, "unauthorized", "unauthorized"), ctx, {
      "WWW-Authenticate": "Bearer",
    });
  }
  await rateLimiter.reset();
  return jsonResponse({ status: "ok", message: "rate limiter state reset" }, ctx);
}
