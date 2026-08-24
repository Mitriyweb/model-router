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

export const cloudflareAdapter: ProviderAdapter = {
  tier: "cloudflare",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return fitsOpenAICompatibleContext(estimatedTokens);
  },

  async send(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.cloudflare.model);
    const url = `${config.cloudflare.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.cloudflare.apiToken}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
    });

    if (!res.ok) {
      const msg = await readProviderError(res, "Cloudflare AI", config.cloudflare.model);
      throw new ProviderError(msg, res.status, res.headers);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.cloudflare.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.cloudflare.model);
    const url = `${config.cloudflare.baseUrl}/chat/completions`;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.cloudflare.apiToken}` },
      payload,
      config.cloudflare.model,
      undefined,
      "cloudflare",
    );
  },
};
