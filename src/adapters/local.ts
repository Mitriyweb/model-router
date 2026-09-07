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

  async send(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model ?? config.local.model;
    const payload = buildOpenAIPayload(req, model);
    const url = `${config.local.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Local model error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return openAIResponseToAnthropic(data, model);
  },

  sendStream(req: NormalizedRequest, opts?: { signal?: AbortSignal }) {
    const model = req.model ?? config.local.model;
    const payload = buildOpenAIPayload(req, model);
    const url = `${config.local.baseUrl}/chat/completions`;
    const signal = opts?.signal ?? req.signal;
    return createOpenAICompatibleStream(url, {}, payload, model, signal, "local");
  },
};
