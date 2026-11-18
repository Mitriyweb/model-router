import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { config } from "../config";

export type ApiFormat = "anthropic" | "openai";

export interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  format: ApiFormat;
  tier?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function tooLarge(): HttpError {
  return new HttpError(413, "request body too large");
}

/** Read a JSON body with a hard size cap and gzip/deflate/br support. */
export async function readJsonBody<T = unknown>(request: Request, format: ApiFormat): Promise<T> {
  const limit = config.maxRequestBodySize;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();

  const compressed = Buffer.from(await request.arrayBuffer());
  if (compressed.byteLength > limit) throw tooLarge();

  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  const decodeOptions = { maxOutputLength: limit + 1 };
  let raw: Buffer;
  try {
    switch (encoding) {
      case undefined:
      case "":
      case "identity":
        raw = compressed;
        break;
      case "gzip":
      case "x-gzip":
        raw = gunzipSync(compressed, decodeOptions);
        break;
      case "deflate":
        raw = inflateSync(compressed, decodeOptions);
        break;
      case "br":
        raw = brotliDecompressSync(compressed, decodeOptions);
        break;
      default:
        throw new HttpError(400, `unsupported content encoding: ${encoding}`);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if ((err as { code?: string } | null)?.code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
    throw new HttpError(400, "invalid compressed request body");
  }

  if (raw.byteLength > limit) throw tooLarge();

  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    const message = format === "openai" ? "Invalid JSON body" : "invalid JSON body";
    throw new HttpError(400, message);
  }
}

function corsHeaders(ctx: RequestContext): Record<string, string> {
  if (!config.corsOrigin) return {};

  const origin = config.corsOrigin === "*" ? "*" : config.corsOrigin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type, authorization, x-router-provider, x-router-tier, x-router-private, x-router-auth-token",
    "Access-Control-Max-Age": "86400",
  };
  if (origin !== "*") headers.Vary = "Origin";
  return headers;
}

/** Attach the headers every response must carry. */
export function withContextHeaders(
  response: Response,
  ctx: RequestContext,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", ctx.requestId);
  if (ctx.tier && !headers.has("x-router-tier")) headers.set("x-router-tier", ctx.tier);
  for (const [name, value] of Object.entries(corsHeaders(ctx))) headers.set(name, value);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(
  data: unknown,
  ctx: RequestContext,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return withContextHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    ctx,
    extra,
  );
}

function errorBody(ctx: RequestContext, status: number, message: string, code?: string): unknown {
  if (ctx.format === "openai") {
    if (status === 502) {
      return { error: { message, type: "all_tiers_exhausted", code: 502 } };
    }
    return { error: { message, type: "invalid_request_error" } };
  }
  if (status === 502) {
    return { error: code ?? "all_tiers_exhausted", detail: message };
  }
  return { error: code ?? message };
}

/** One place that maps failures to the format the client expects. */
export function errorResponse(
  err: unknown,
  ctx: RequestContext,
  extra: Record<string, string> = {},
): Response {
  let status = 500;
  const message = err instanceof Error ? err.message : String(err);
  let code: string | undefined;

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
  }

  return jsonResponse(errorBody(ctx, status, message, code), ctx, status, extra);
}

export function isResetAuthorized(request: Request): boolean {
  if (!config.authToken) return true;
  const authorization = request.headers.get("authorization");
  return (
    authorization === `Bearer ${config.authToken}` ||
    request.headers.get("x-router-auth-token") === config.authToken
  );
}
