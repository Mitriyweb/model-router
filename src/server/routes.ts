import { config } from "../config";
import type { TierName } from "../types";
import {
  handleChatCompletions,
  handleHealth,
  handleMessages,
  handleModels,
  handleProviders,
  handleReset,
  handleStatus,
  isValidTier,
} from "./handlers";
import {
  type ApiFormat,
  HttpError,
  type RequestContext,
  errorResponse,
  jsonResponse,
  withContextHeaders,
} from "./http";

interface Route {
  methods: readonly string[];
  pattern: RegExp | string;
  format: ApiFormat;
  handler: (ctx: RequestContext) => Response | Promise<Response>;
  /** Named regex group that must contain a valid provider tier. */
  tierParam?: string;
}

const routes: Route[] = [
  {
    methods: ["POST"],
    pattern: /^\/(?:v1\/)?providers\/(?<provider>[^/]+)\/messages$/,
    format: "anthropic",
    tierParam: "provider",
    handler: (ctx) => handleMessages(ctx, ctx.params.provider as TierName),
  },
  {
    methods: ["POST"],
    pattern: /^\/(?:v1\/)?providers\/(?<provider>[^/]+)\/chat\/completions$/,
    format: "openai",
    tierParam: "provider",
    handler: (ctx) => handleChatCompletions(ctx, ctx.params.provider as TierName),
  },
  {
    methods: ["POST"],
    pattern: "/v1/messages",
    format: "anthropic",
    handler: (ctx) => handleMessages(ctx),
  },
  {
    methods: ["POST"],
    pattern: "/v1/chat/completions",
    format: "openai",
    handler: (ctx) => handleChatCompletions(ctx),
  },
  {
    methods: ["POST"],
    pattern: "/chat/completions",
    format: "openai",
    handler: (ctx) => handleChatCompletions(ctx),
  },
  {
    methods: ["GET"],
    pattern: "/v1/models",
    format: "openai",
    handler: handleModels,
  },
  {
    methods: ["GET"],
    pattern: "/models",
    format: "openai",
    handler: handleModels,
  },
  {
    methods: ["GET"],
    pattern: "/v1/providers",
    format: "openai",
    handler: handleProviders,
  },
  {
    methods: ["GET"],
    pattern: "/providers",
    format: "openai",
    handler: handleProviders,
  },
  {
    methods: ["GET"],
    pattern: "/status",
    format: "anthropic",
    handler: handleStatus,
  },
  {
    methods: ["POST", "DELETE"],
    pattern: "/reset",
    format: "anthropic",
    handler: handleReset,
  },
  {
    methods: ["POST", "DELETE"],
    pattern: "/reset-state",
    format: "anthropic",
    handler: handleReset,
  },
  {
    methods: ["POST", "DELETE"],
    pattern: "/v1/reset",
    format: "anthropic",
    handler: handleReset,
  },
  {
    methods: ["GET"],
    pattern: "/health",
    format: "anthropic",
    handler: handleHealth,
  },
];

function matchPath(pattern: Route["pattern"], pathname: string): Record<string, string> | null {
  if (typeof pattern === "string") return pathname === pattern ? {} : null;

  const match = pattern.exec(pathname);
  if (!match) return null;
  return Object.fromEntries(
    Object.entries(match.groups ?? {}).map(([name, value]) => [name, value ?? ""]),
  );
}

/** Dispatch a request through the route table with consistent headers/errors. */
export async function dispatchRequest(ctx: RequestContext): Promise<Response> {
  const { request, url } = ctx;
  const allowed = new Set<string>();
  let pathFormat: ApiFormat = "anthropic";

  for (const route of routes) {
    const params = matchPath(route.pattern, url.pathname);
    if (!params) continue;

    pathFormat = route.format;
    for (const method of route.methods) allowed.add(method);
    if (!route.methods.includes(request.method)) continue;

    ctx.format = route.format;
    ctx.params = params;

    if (route.tierParam) {
      const tier = params[route.tierParam];
      if (!isValidTier(tier)) {
        return errorResponse(new HttpError(400, `Unknown provider: ${tier}`), ctx);
      }
      params[route.tierParam] = tier.toLowerCase();
    }

    return route.handler(ctx);
  }

  if (allowed.size > 0) {
    ctx.format = pathFormat;
    if (request.method === "OPTIONS" && config.corsOrigin) {
      return withContextHeaders(new Response(null, { status: 204 }), ctx);
    }
    return errorResponse(new HttpError(405, "method not allowed"), ctx, {
      Allow: Array.from(allowed).join(", "),
    });
  }

  return jsonResponse({ error: "not found" }, ctx, 404);
}
