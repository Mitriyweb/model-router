import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  OPENAI_COMPATIBLE_CONTEXT_LIMIT,
  ProviderError,
} from "../../src/adapters/openaiCompatible";
import { config } from "../../src/config";
import { PROVIDERS, VALID_TIERS, adapters } from "../../src/providers";
import type { ProviderConfig, ProviderDefinition } from "../../src/providers";
import type { CredentialField } from "../../src/providers/definitions";
import { rateLimiter } from "../../src/rateLimiter";
import type { NormalizedRequest, TierName } from "../../src/types";

const OPENAI_TIERS = VALID_TIERS.filter(
  (tier) => (PROVIDERS[tier] as ProviderDefinition).protocol === "openai",
);

const baseReq: NormalizedRequest = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [],
  stream: false,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe.each(OPENAI_TIERS)("%s OpenAI-compatible adapter contract", (tier: TierName) => {
  const definition = PROVIDERS[tier] as ProviderDefinition;
  const adapter = adapters[tier];
  const cfg = config[tier] as ProviderConfig;
  const credentials = (definition.credentials ?? ["apiKey"]) as readonly CredentialField[];
  const snapshot = { ...cfg, limits: { ...cfg.limits } };
  let originalFetch: typeof globalThis.fetch;
  let calls: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    for (const field of credentials) cfg[field] = `test-${field}`;
    if (definition.envExtras?.includes("provider")) cfg.provider = "test-upstream";
    if (definition.requiresModel) cfg.model = "test-model";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        id: `chatcmpl-${tier}`,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Hello from ${tier}!` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Object.assign(cfg, snapshot);
    cfg.limits = { ...snapshot.limits };
    await rateLimiter.reset();
  });

  it("sends a normalized request to the configured endpoint with provider headers", async () => {
    const response = await adapter.send(baseReq);

    expect(response.role).toBe("assistant");
    expect(response.model).toBe(cfg.model);
    expect(response.content[0]).toEqual({ type: "text", text: `Hello from ${tier}!` });
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0]!;
    expect(url.startsWith(cfg.baseUrl)).toBe(true);
    expect(url.endsWith("/chat/completions")).toBe(true);

    const headers = new Headers(init?.headers);
    const authField = credentials.find((field) => field === "apiToken" || field === "apiKey");
    if (authField) {
      expect(headers.get("authorization")).toBe(`Bearer ${cfg[authField]}`);
    } else {
      expect(headers.get("authorization")).toBeNull();
    }
    for (const [name, value] of Object.entries(definition.extraHeaders?.(cfg) ?? {})) {
      expect(headers.get(name)).toBe(value);
    }

    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      model: cfg.model,
      stream: false,
      messages: [
        { role: "system", content: baseReq.systemPrompt },
        { role: "user", content: "Hello!" },
      ],
    });
  });

  it("uses an explicit request model and reports context limits from the registry", () => {
    const limit =
      definition.contextLimit === "router"
        ? config.routerMaxContextTokens
        : (definition.contextLimit ?? OPENAI_COMPATIBLE_CONTEXT_LIMIT);

    expect(adapter.canHandle(baseReq, limit)).toBe(true);
    expect(adapter.canHandle(baseReq, limit + 1)).toBe(false);

    if (definition.requiresModel) {
      cfg.model = "";
      expect(adapter.canHandle(baseReq, 1)).toBe(false);
      cfg.model = "test-model";
    }

    expect(adapter.canHandle({ ...baseReq, model: "custom-model" }, limit)).toBe(true);
  });

  it("translates upstream SSE into Anthropic stream events", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return sseResponse([
        { choices: [{ index: 0, delta: { content: "Hello" } }] },
        { choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]);
    }) as unknown as typeof fetch;

    const stream = adapter.sendStream!(baseReq);
    const text = await new Response(stream).text();

    expect(text).toContain("event: message_start");
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).toContain("event: message_stop");
    expect(text).toContain('"output_tokens":5');
    expect(JSON.parse(String(calls[0]?.init?.body)).stream).toBe(true);
  });

  it("maps upstream failures to ProviderError with status and headers", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: `quota exceeded for ${tier}` } }, 429, {
        "retry-after": "1",
      })) as unknown as typeof fetch;

    let error: unknown;
    try {
      await adapter.send(baseReq);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(429);
    expect((error as ProviderError).message).toContain(`quota exceeded for ${tier}`);
  });
});
