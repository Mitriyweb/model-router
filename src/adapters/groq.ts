import { config } from "../config";
import type { NormalizedRequest, ProviderAdapter } from "../types";
import {
  buildOpenAIPayload,
  createOpenAICompatibleStream,
  fitsOpenAICompatibleContext,
  openAIResponseToAnthropic,
} from "./openaiCompatible";

export const groqAdapter: ProviderAdapter = {
  tier: "groq",

  canHandle(_req: NormalizedRequest, estimatedTokens: number) {
    if (estimatedTokens > config.groq.limits.tpm) {
      return false;
    }
    return fitsOpenAICompatibleContext(estimatedTokens);
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
      const raw = await res.text();
      console.warn("[groq] upstream error body:", raw);
      const { ProviderError } = await import("./openaiCompatible");
      throw new ProviderError(`Groq error ${res.status}: ${raw}`, res.status, res.headers);
    }

    const data = await res.json();
    console.log("[groq] upstream response:", JSON.stringify(data).slice(0, 1200));
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
