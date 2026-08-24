import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import { TierName } from "../types";
import {
  ProviderError,
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
  readProviderError,
} from "./openaiCompatible";

export const mistralAdapter: ProviderAdapter = {
  tier: TierName.Mistral,

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return fitsOpenAICompatibleContext(estimatedTokens, config.routerMaxContextTokens);
  },

  async send(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const payload = buildOpenAIPayload(req, config.mistral.model);
    const url = `${config.mistral.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mistral.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });

    if (!res.ok) {
      const msg = await readProviderError(res, "Mistral", config.mistral.model);
      throw new ProviderError(msg, res.status, res.headers);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.mistral.model);
  },

  sendStream(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const payload = buildOpenAIPayload(req, config.mistral.model);
    const url = `${config.mistral.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.mistral.apiKey}` },
      payload,
      config.mistral.model,
      signal,
      TierName.Mistral,
    );
  },
};
