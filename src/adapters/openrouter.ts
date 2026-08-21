import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
  readProviderError,
} from "./openaiCompatible";

export const openrouterAdapter: ProviderAdapter = {
  tier: "openrouter",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    if (estimatedTokens > config.openrouter.limits.tpm) {
      return false;
    }
    return fitsOpenAICompatibleContext(estimatedTokens);
  },

  async send(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.openrouter.model);
    const url = `${config.openrouter.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "HTTP-Referer": "https://github.com/Mitriyweb/model-router",
        "X-Title": "model-router",
      },
      body: JSON.stringify({ ...payload, stream: false }),
    });

    if (!res.ok) {
      const msg = await readProviderError(res, "OpenRouter", config.openrouter.model);
      const { ProviderError } = await import("./openaiCompatible");
      throw new ProviderError(msg, res.status, res.headers);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.openrouter.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.openrouter.model);
    const url = `${config.openrouter.baseUrl}/chat/completions`;
    return createOpenAICompatibleStream(
      url,
      {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "HTTP-Referer": "https://github.com/Mitriyweb/model-router",
        "X-Title": "model-router",
      },
      payload,
      config.openrouter.model,
    );
  },
};
