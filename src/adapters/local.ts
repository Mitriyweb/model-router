import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
} from "./openaiCompatible";

export const localAdapter: ProviderAdapter = {
  tier: "local",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return fitsOpenAICompatibleContext(estimatedTokens);
  },

  async send(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.local.model);
    const url = `${config.local.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: false }),
    });

    if (!res.ok) {
      throw new Error(`Local model error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.local.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.local.model);
    const url = `${config.local.baseUrl}/chat/completions`;
    return createOpenAICompatibleStream(url, {}, payload, config.local.model);
  },
};
