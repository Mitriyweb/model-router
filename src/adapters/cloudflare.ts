import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
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
      throw new Error(`Cloudflare AI error ${res.status}: ${await res.text()}`);
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
    );
  },
};
