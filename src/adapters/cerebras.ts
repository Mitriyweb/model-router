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

export const cerebrasAdapter: ProviderAdapter = {
  tier: "cerebras",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return fitsOpenAICompatibleContext(estimatedTokens, config.routerMaxContextTokens);
  },

  async send(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model && req.model !== "cerebras" ? req.model : config.cerebras.model;
    const payload = buildOpenAIPayload(req, model);
    const url = `${config.cerebras.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.cerebras.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });

    if (!res.ok) {
      const msg = await readProviderError(res, "Cerebras", model);
      throw new ProviderError(msg, res.status, res.headers);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, model);
  },

  sendStream(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model && req.model !== "cerebras" ? req.model : config.cerebras.model;
    const payload = buildOpenAIPayload(req, model);
    const url = `${config.cerebras.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.cerebras.apiKey}` },
      payload,
      model,
      signal,
      "cerebras",
    );
  },
};
