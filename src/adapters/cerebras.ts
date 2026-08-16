import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  openAIResponseToAnthropic,
} from "./openaiCompatible";

export const cerebrasAdapter: ProviderAdapter = {
  tier: "cerebras",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return estimatedTokens <= config.cerebras.limits.tpm;
  },

  async send(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.cerebras.model);
    const url = `${config.cerebras.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.cerebras.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
    });

    if (!res.ok) {
      throw new Error(`Cerebras error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.cerebras.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.cerebras.model);
    const url = `${config.cerebras.baseUrl}/chat/completions`;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.cerebras.apiKey}` },
      payload,
      config.cerebras.model,
    );
  },
};
