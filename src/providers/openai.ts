import {
  OPENAI_COMPATIBLE_CONTEXT_LIMIT,
  ProviderError,
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
  readProviderError,
} from "../adapters/openaiCompatible";
import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter, TierName } from "../types";
import type { CredentialField, ProviderConfig, ProviderDefinition } from "./definitions";

const DEFAULT_CREDENTIALS: readonly CredentialField[] = ["apiKey"];

function contextLimit(definition: ProviderDefinition): number {
  if (definition.contextLimit === "router") return config.routerMaxContextTokens;
  return definition.contextLimit ?? OPENAI_COMPATIBLE_CONTEXT_LIMIT;
}

function authHeaders(definition: ProviderDefinition, cfg: ProviderConfig): Record<string, string> {
  const credentials = definition.credentials ?? DEFAULT_CREDENTIALS;
  const field = credentials.find((name) => name === "apiToken" || name === "apiKey");
  if (!field) return {};
  return { Authorization: `Bearer ${cfg[field]}` };
}

function headersFor(definition: ProviderDefinition, cfg: ProviderConfig): Record<string, string> {
  return { ...authHeaders(definition, cfg), ...definition.extraHeaders?.(cfg) };
}

/**
 * Build a `ProviderAdapter` for any OpenAI-compatible endpoint from its
 * registry definition. The adapter reads the mutable `config` at call time so
 * runtime overrides (and tests) keep working.
 */
export function createOpenAIAdapter(
  tier: TierName,
  definition: ProviderDefinition,
): ProviderAdapter {
  const cfg = () => config[tier];

  return {
    tier,

    canHandle(_req: NormalizedRequest, estimatedTokens: number) {
      if (definition.requiresModel && !cfg().model) return false;
      return fitsOpenAICompatibleContext(estimatedTokens, contextLimit(definition));
    },

    async send(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
      const settings = cfg();
      const model = req.model ?? settings.model;
      const payload = buildOpenAIPayload(req, model);
      const url = `${settings.baseUrl}/chat/completions`;
      const signal = opts?.signal ?? req.signal;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headersFor(definition, settings),
        },
        body: JSON.stringify({ ...payload, stream: false }),
        signal,
      });

      if (!res.ok) {
        const message = await readProviderError(res, definition.label, model);
        throw new ProviderError(message, res.status, res.headers);
      }

      const data = await res.json();
      return openAIResponseToAnthropic(data, model);
    },

    sendStream(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
      const settings = cfg();
      const model = req.model ?? settings.model;
      const payload = buildOpenAIPayload(req, model);
      const url = `${settings.baseUrl}/chat/completions`;
      const signal = opts?.signal ?? req.signal;

      return createOpenAICompatibleStream(
        url,
        headersFor(definition, settings),
        payload,
        model,
        signal,
        tier,
      );
    },
  };
}
