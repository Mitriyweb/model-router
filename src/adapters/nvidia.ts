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

export const nvidiaAdapter: ProviderAdapter = {
  tier: "nvidia",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return fitsOpenAICompatibleContext(estimatedTokens);
  },

  async send(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.nvidia.model);
    const url = `${config.nvidia.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.nvidia.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
    });

    if (!res.ok) {
      const msg = await readProviderError(res, "NVIDIA NIM", config.nvidia.model);
      throw new ProviderError(msg, res.status, res.headers);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.nvidia.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.nvidia.model);
    const url = `${config.nvidia.baseUrl}/chat/completions`;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.nvidia.apiKey}` },
      payload,
      config.nvidia.model,
      undefined,
      "nvidia",
    );
  },
};
