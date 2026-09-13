import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  ProviderError,
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
  readProviderError,
} from "./openaiCompatible";

export const OPENCODE_CONTEXT_WINDOW = 262_144;
export const OPENCODE_MAX_OUTPUT_TOKENS = 32_768;

export const opencodeAdapter: ProviderAdapter = {
  tier: "opencode",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    const maxAllowedContext = Math.min(OPENCODE_CONTEXT_WINDOW, config.routerMaxContextTokens);
    return fitsOpenAICompatibleContext(estimatedTokens, maxAllowedContext);
  },

  async send(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model ?? config.opencode.model;
    const payload = buildOpenAIPayload(req, model);
    if (typeof payload.max_tokens === "number" && payload.max_tokens > OPENCODE_MAX_OUTPUT_TOKENS) {
      payload.max_tokens = OPENCODE_MAX_OUTPUT_TOKENS;
    }

    const url = `${config.opencode.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.opencode.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });

    if (!res.ok) {
      const msg = await readProviderError(res, "OpenCode Zen", model);
      throw new ProviderError(msg, res.status, res.headers);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, model);
  },

  sendStream(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model ?? config.opencode.model;
    const payload = buildOpenAIPayload(req, model);
    if (typeof payload.max_tokens === "number" && payload.max_tokens > OPENCODE_MAX_OUTPUT_TOKENS) {
      payload.max_tokens = OPENCODE_MAX_OUTPUT_TOKENS;
    }

    const url = `${config.opencode.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.opencode.apiKey}` },
      payload,
      model,
      signal,
      "opencode",
    );
  },
};
