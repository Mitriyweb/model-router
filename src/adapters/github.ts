import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  openAIResponseToAnthropic,
} from "./openaiCompatible";

export const githubAdapter: ProviderAdapter = {
  tier: "github",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    return estimatedTokens <= config.github.limits.tpm;
  },

  async send(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.github.model);
    const url = `${config.github.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.github.token}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
    });

    if (!res.ok) {
      throw new Error(`GitHub Models error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.github.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.github.model);
    const url = `${config.github.baseUrl}/chat/completions`;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.github.token}` },
      payload,
      config.github.model,
    );
  },
};
