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

  async send(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model && req.model !== "cloudflare" ? req.model : config.cloudflare.model;
    const payload = buildOpenAIPayload(req, model);
    const url = `${config.cloudflare.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.cloudflare.apiToken}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });

    if (!res.ok) {
      const msg = await readProviderError(res, "Cloudflare AI", model);
      throw new ProviderError(msg, res.status, res.headers);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, model);
  },

  sendStream(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model && req.model !== "cloudflare" ? req.model : config.cloudflare.model;
    const payload = buildOpenAIPayload(req, model);
    const url = `${config.cloudflare.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.cloudflare.apiToken}` },
      payload,
      model,
      signal,
      "cloudflare",
    );
  },
};
