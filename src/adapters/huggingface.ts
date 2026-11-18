import { config } from "../config";
import { log } from "../log";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  ProviderError,
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
  readProviderError,
} from "./openaiCompatible";

function hfHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.huggingface.apiKey}`,
  };
  if (config.huggingface.provider) {
    // Standard Hugging Face Inference Providers routing header
    headers["x-hf-provider"] = config.huggingface.provider;
  }
  return headers;
}

export const huggingfaceAdapter: ProviderAdapter = {
  tier: "huggingface",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    if (!config.huggingface.model) {
      log.warn("[HF] skip: no model configured (HF_MODEL is empty)");
      return false;
    }
    return fitsOpenAICompatibleContext(estimatedTokens, config.routerMaxContextTokens);
  },

  async send(req: NormalizedRequest) {
    const model = req.model ?? config.huggingface.model;
    log.debug("[HF] request started");
    log.debug(`[HF] model=${model}`);
    if (config.huggingface.provider) {
      log.debug(`[HF] provider=${config.huggingface.provider}`);
    }

    const payload = buildOpenAIPayload(req, model);
    const url = `${config.huggingface.baseUrl}/chat/completions`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...hfHeaders(),
        },
        body: JSON.stringify({ ...payload, stream: false }),
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      log.error(`[HF] error: ${msg}`);
      throw err;
    }

    if (!res.ok) {
      if (res.status === 429) {
        log.warn("[HF] error: rate limit");
      } else {
        log.warn(`[HF] error: HTTP ${res.status}`);
      }
      const message = await readProviderError(res, "Hugging Face", model);
      throw new ProviderError(message, res.status, res.headers);
    }

    const data = await res.json();
    log.debug("[HF] success");
    return openAIResponseToAnthropic(data, model);
  },

  sendStream(req: NormalizedRequest) {
    const model = req.model ?? config.huggingface.model;
    log.debug("[HF] request started (stream)");
    log.debug(`[HF] model=${model}`);
    if (config.huggingface.provider) {
      log.debug(`[HF] provider=${config.huggingface.provider}`);
    }

    const payload = buildOpenAIPayload(req, model);
    const url = `${config.huggingface.baseUrl}/chat/completions`;

    return createOpenAICompatibleStream(url, hfHeaders(), payload, model);
  },
};
