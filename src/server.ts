import { config } from "./config";
import { rateLimiter } from "./rateLimiter";
import { routeRequest, routeRequestStream } from "./router";
import type { AnthropicRequest, NormalizedRequest } from "./types";

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

function handleStatus(): Response {
  const tiers = [
    "github",
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
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/v1/messages" && request.method === "POST") {
        return handleMessages(request);
      }
      if (url.pathname === "/status" && request.method === "GET") {
        return handleStatus();
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ status: "ok" });
      }
      return json({ error: "not found" }, 404);
    },
  });

  console.log(`model-router listening on http://localhost:${server.port}`);
  console.log(
    `Point Claude Code at it with: export ANTHROPIC_BASE_URL=http://localhost:${server.port}`,
  );
  return server;
}
