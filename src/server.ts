import { anthropicResponseToOpenAI, openAIRequestToNormalized } from "./adapters/openaiCompatible";
import { config } from "./config";
import { rateLimiter } from "./rateLimiter";
import { hasCredentials, routeRequest, routeRequestStream } from "./router";
import { anthropicStreamToOpenAI } from "./streaming/openaiSSE";
import type { AnthropicRequest, NormalizedRequest, TierName } from "./types";

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

async function handleMessages(request: Request, forceTier?: TierName): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const headerTier = parseTierHeader(request);
  const targetTier = forceTier ?? headerTier;
  const forcePrivate = request.headers.get("x-router-private") === "true";
  const normalized = normalize(body);

  if (normalized.stream) {
    return handleStreamingMessages(normalized, forcePrivate, targetTier);
  }

  try {
    const result = await routeRequest(normalized, { forcePrivate, forceTier: targetTier });
    const policyStr = result.policyApplied ? ` [policy: ${result.policyApplied}]` : "";
    const skippedStr = result.attempts.length
      ? ` (skipped: ${result.attempts.map((a) => a.tier).join(", ")})`
      : "";
    console.log(`[router] served via ${result.tierUsed}${policyStr}${skippedStr}`);
    return json(result.response, 200, { "x-router-tier": result.tierUsed });
  } catch (err: any) {
    console.error("[router] all tiers failed:", err.message);
    return json({ error: "all_tiers_exhausted", detail: err.message }, 502);
  }
}

async function handleStreamingMessages(
  normalized: NormalizedRequest,
  forcePrivate: boolean,
  forceTier?: TierName,
): Promise<Response> {
  try {
    const result = await routeRequestStream(normalized, { forcePrivate, forceTier });
    const policyStr = result.policyApplied ? ` [policy: ${result.policyApplied}]` : "";
    console.log(`[router] streaming via ${result.tierUsed}${policyStr}`);
    return new Response(result.stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-router-tier": result.tierUsed,
      },
    });
  } catch (err: any) {
    console.error("[router] streaming setup failed:", err.message);
    return json({ error: "all_tiers_exhausted", detail: err.message }, 502);
  }
}

const VALID_TIERS: TierName[] = [
  "cerebras",
  "groq",
  "gemini",
  "openrouter",
  "mistral",
  "nvidia",
  "huggingface",
  "cloudflare",
  "cohere",
  "local",
];

function isValidTier(tier?: string | null): tier is TierName {
  if (!tier) return false;
  return VALID_TIERS.includes(tier.toLowerCase() as TierName);
}

function parseTierHeader(request: Request): TierName | undefined {
  const header = request.headers.get("x-router-provider") || request.headers.get("x-router-tier");
  if (isValidTier(header)) {
    return header.toLowerCase() as TierName;
  }
  return undefined;
}

export function parseModelTierOverride(modelName?: string): {
  tier?: TierName;
  cleanModel: string;
} {
  if (!modelName) return { cleanModel: "model-router-auto" };

  for (const tier of VALID_TIERS) {
    if (modelName === tier || modelName.startsWith(`${tier}/`)) {
      const cleanModel = modelName.startsWith(`${tier}/`)
        ? modelName.slice(tier.length + 1)
        : modelName;
      return {
        tier,
        cleanModel: cleanModel || modelName,
      };
    }
  }

  return { cleanModel: modelName };
}

async function handleChatCompletions(request: Request, forceTier?: TierName): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  const requestedModel = body.model || "model-router-auto";
  const { tier: tierOverride, cleanModel } = parseModelTierOverride(requestedModel);
  const headerTier = parseTierHeader(request);
  const targetTier = forceTier ?? headerTier ?? tierOverride;

  const isLocalModel = requestedModel === "local" || requestedModel.startsWith("local/");
  const forcePrivate = request.headers.get("x-router-private") === "true" || isLocalModel;

  const normalized = openAIRequestToNormalized(body, cleanModel);

  if (normalized.stream) {
    try {
      const result = await routeRequestStream(normalized, { forcePrivate, forceTier: targetTier });
      const openAIStream = anthropicStreamToOpenAI(result.stream, requestedModel);
      console.log(`[router/openai] streaming via ${result.tierUsed} [model: ${requestedModel}]`);
      return new Response(openAIStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "x-router-tier": result.tierUsed,
        },
      });
    } catch (err: any) {
      console.error("[router/openai] streaming setup failed:", err.message);
      return json({ error: { message: err.message, type: "all_tiers_exhausted", code: 502 } }, 502);
    }
  }

  try {
    const result = await routeRequest(normalized, { forcePrivate, forceTier: targetTier });
    console.log(`[router/openai] served via ${result.tierUsed} [model: ${requestedModel}]`);
    const openAIResponse = anthropicResponseToOpenAI(result.response, requestedModel);
    return json(openAIResponse, 200, { "x-router-tier": result.tierUsed });
  } catch (err: any) {
    console.error("[router/openai] request failed:", err.message);
    return json({ error: { message: err.message, type: "all_tiers_exhausted", code: 502 } }, 502);
  }
}

function handleModels(): Response {
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
    const defaultModel = "model" in tierConfig ? (tierConfig.model as string) : "";

    // Add provider identifier alias as a model
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

  // Additional known provider models
  const knownExtraModels: { id: string; owned_by: TierName }[] = [
    { id: "mistral-large-latest", owned_by: "mistral" },
  ];

  for (const extra of knownExtraModels) {
    const configured = hasCredentials(extra.owned_by);
    modelsMap.set(extra.id, {
      id: extra.id,
      object: "model",
      created: 1700000000,
      owned_by: extra.owned_by,
      configured,
    });
  }

  return json({ object: "list", data: Array.from(modelsMap.values()) });
}

function handleProviders(): Response {
  const providers = VALID_TIERS.map((tier) => {
    const tierConfig = config[tier];
    const configured = hasCredentials(tier);
    const defaultModel = "model" in tierConfig ? (tierConfig.model as string) : "";
    const snapshot = rateLimiter.snapshot(tier, tierConfig.limits);

    return {
      id: tier,
      name: tier,
      configured,
      model: defaultModel,
      limits: tierConfig.limits,
      status: snapshot,
    };
  });

  return json({ object: "list", data: providers });
}

function handleStatus(): Response {
  const snapshot = Object.fromEntries(
    VALID_TIERS.map((t) => [t, rateLimiter.snapshot(t, config[t].limits)]),
  );
  return json({ status: "ok", tiers: snapshot });
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function startServer(port = config.port) {
  const server = Bun.serve({
    port,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);

      // Specific provider endpoint routing: /v1/providers/:provider/messages or /providers/:provider/messages
      const providerMessagesMatch = url.pathname.match(/^\/(?:v1\/)?providers\/([^/]+)\/messages$/);
      if (providerMessagesMatch && request.method === "POST") {
        const providerStr = providerMessagesMatch[1];
        if (!isValidTier(providerStr)) {
          return json({ error: `Unknown provider: ${providerStr}` }, 400);
        }
        return handleMessages(request, providerStr);
      }

      // Specific provider endpoint routing: /v1/providers/:provider/chat/completions or /providers/:provider/chat/completions
      const providerCompletionsMatch = url.pathname.match(
        /^\/(?:v1\/)?providers\/([^/]+)\/chat\/completions$/,
      );
      if (providerCompletionsMatch && request.method === "POST") {
        const providerStr = providerCompletionsMatch[1];
        if (!isValidTier(providerStr)) {
          return json(
            {
              error: { message: `Unknown provider: ${providerStr}`, type: "invalid_request_error" },
            },
            400,
          );
        }
        return handleChatCompletions(request, providerStr);
      }

      // Anthropic API (Claude Code)
      if (url.pathname === "/v1/messages" && request.method === "POST") {
        return handleMessages(request);
      }

      // OpenAI API (ZeroClaw, Aider, Cline, Roo Code, Chat UIs)
      if (
        (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") &&
        request.method === "POST"
      ) {
        return handleChatCompletions(request);
      }

      // Models list
      if (
        (url.pathname === "/v1/models" || url.pathname === "/models") &&
        request.method === "GET"
      ) {
        return handleModels();
      }

      // Providers list
      if (
        (url.pathname === "/v1/providers" || url.pathname === "/providers") &&
        request.method === "GET"
      ) {
        return handleProviders();
      }

      if (url.pathname === "/status" && request.method === "GET") {
        return handleStatus();
      }
      if (
        (url.pathname === "/reset" ||
          url.pathname === "/reset-state" ||
          url.pathname === "/v1/reset") &&
        (request.method === "POST" || request.method === "DELETE")
      ) {
        await rateLimiter.reset();
        return json({ status: "ok", message: "rate limiter state reset" });
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ status: "ok" });
      }
      return json({ error: "not found" }, 404);
    },
  });

  console.log(`model-router listening on http://localhost:${server.port}`);
  console.log(`  Anthropic: export ANTHROPIC_BASE_URL=http://localhost:${server.port}`);
  console.log(`  OpenAI:    export OPENAI_BASE_URL=http://localhost:${server.port}/v1`);
  return server;
}
