import { anthropicResponseToOpenAI, openAIRequestToNormalized } from "./adapters/openaiCompatible";
import { config } from "./config";
import { rateLimiter } from "./rateLimiter";
import { routeRequest, routeRequestStream } from "./router";
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

async function handleMessages(request: Request): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const forcePrivate = request.headers.get("x-router-private") === "true";
  const normalized = normalize(body);

  if (normalized.stream) {
    return handleStreamingMessages(normalized, forcePrivate);
  }

  try {
    const result = await routeRequest(normalized, { forcePrivate });
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
): Promise<Response> {
  try {
    const result = await routeRequestStream(normalized, { forcePrivate });
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

function parseModelTierOverride(modelName?: string): { tier?: TierName; cleanModel: string } {
  if (!modelName) return { cleanModel: "model-router-auto" };

  const validTiers: TierName[] = [
    "cerebras",
    "groq",
    "gemini",
    "openrouter",
    "mistral",
    "nvidia",
    "cloudflare",
    "cohere",
    "local",
  ];

  for (const tier of validTiers) {
    if (modelName === tier || modelName.startsWith(`${tier}/`)) {
      return {
        tier,
        cleanModel: modelName.includes("/") ? modelName.split("/")[1] : modelName,
      };
    }
  }

  return { cleanModel: modelName };
}

async function handleChatCompletions(request: Request): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  const requestedModel = body.model || "model-router-auto";
  const { tier: tierOverride } = parseModelTierOverride(requestedModel);
  const forcePrivate =
    request.headers.get("x-router-private") === "true" || requestedModel.startsWith("local");

  const normalized = openAIRequestToNormalized(body);

  if (normalized.stream) {
    try {
      const result = await routeRequestStream(normalized, { forcePrivate });
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
    const result = await routeRequest(normalized, { forcePrivate });
    console.log(`[router/openai] served via ${result.tierUsed} [model: ${requestedModel}]`);
    const openAIResponse = anthropicResponseToOpenAI(result.response, requestedModel);
    return json(openAIResponse, 200, { "x-router-tier": result.tierUsed });
  } catch (err: any) {
    console.error("[router/openai] request failed:", err.message);
    return json({ error: { message: err.message, type: "all_tiers_exhausted", code: 502 } }, 502);
  }
}

function handleModels(): Response {
  const models = [
    { id: "model-router-auto", object: "model", created: 1700000000, owned_by: "model-router" },
    { id: "llama-3.3-70b", object: "model", created: 1700000000, owned_by: "cerebras" },
    { id: "llama-3.3-70b-versatile", object: "model", created: 1700000000, owned_by: "groq" },
    { id: "gemini-3.7-flash", object: "model", created: 1700000000, owned_by: "gemini" },
    { id: "codestral-latest", object: "model", created: 1700000000, owned_by: "mistral" },
    { id: "mistral-large-latest", object: "model", created: 1700000000, owned_by: "mistral" },
    { id: "command-r-plus-08-2024", object: "model", created: 1700000000, owned_by: "cohere" },
    { id: "qwen2.5-coder:7b", object: "model", created: 1700000000, owned_by: "local" },
  ];
  return json({ object: "list", data: models });
}

function handleStatus(): Response {
  const tiers = [
    "cerebras",
    "groq",
    "gemini",
    "openrouter",
    "mistral",
    "nvidia",
    "cloudflare",
    "cohere",
    "local",
  ] as const;
  const snapshot = Object.fromEntries(
    tiers.map((t) => [t, rateLimiter.snapshot(t, config[t].limits)]),
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
