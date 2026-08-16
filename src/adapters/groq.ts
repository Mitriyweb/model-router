import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  openAIResponseToAnthropic,
} from "./openaiCompatible";

export const groqAdapter: ProviderAdapter = {
  tier: "groq",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    // Groq free tier limit: 6000 TPM limit
    return estimatedTokens <= config.groq.limits.tpm;
  },

  async send(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.groq.model);
    const url = `${config.groq.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.groq.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
    });

    if (!res.ok) {
      throw new Error(`Groq error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, config.groq.model);
  },

  sendStream(req: NormalizedRequest) {
    const payload = buildOpenAIPayload(req, config.groq.model);
    const url = `${config.groq.baseUrl}/chat/completions`;
    return createOpenAICompatibleStream(
      url,
      { Authorization: `Bearer ${config.groq.apiKey}` },
      payload,
      config.groq.model,
    );
  },
};
