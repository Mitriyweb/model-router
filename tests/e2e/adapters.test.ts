import { describe, expect, test } from "bun:test";
import { cerebrasAdapter } from "../../src/adapters/cerebras";
import { cloudflareAdapter } from "../../src/adapters/cloudflare";
import { cohereAdapter } from "../../src/adapters/cohere";
import { geminiAdapter } from "../../src/adapters/gemini";
import { groqAdapter } from "../../src/adapters/groq";
import { localAdapter } from "../../src/adapters/local";
import { mistralAdapter } from "../../src/adapters/mistral";
import { nvidiaAdapter } from "../../src/adapters/nvidia";
import { openrouterAdapter } from "../../src/adapters/openrouter";
import { config } from "../../src/config";
import type { NormalizedRequest, ProviderAdapter } from "../../src/types";

const shouldRunE2E = process.env.RUN_E2E === "true" || process.env.RUN_E2E === "1";

function isKeyValid(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  if (!trimmed || trimmed.includes("...") || trimmed.startsWith("dummy")) return false;
  return true;
}

const minimalReq: NormalizedRequest = {
  systemPrompt: "",
  messages: [{ role: "user", content: "Hi" }],
  tools: [],
  maxTokens: 5,
  temperature: 0.1,
  stream: false,
};

async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function isTransientError(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  const status = Number(err?.status ?? 0);
  return (
    status === 503 ||
    status === 429 ||
    status === 504 ||
    msg.includes("high demand") ||
    msg.includes("resource has been exhausted") ||
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("service unavailable") ||
    msg.includes("overloaded")
  );
}

async function testAdapter(adapter: ProviderAdapter) {
  const signal = AbortSignal.timeout(25_000);

  try {
    // Test unary send
    const res = await adapter.send(minimalReq, { signal });
    expect(res).toBeDefined();
    expect(res.id).toBeString();
    expect(res.role).toBe("assistant");
    expect(Array.isArray(res.content)).toBeTrue();
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.usage).toBeDefined();

    // Test streaming sendStream
    if (adapter.sendStream) {
      const streamSignal = AbortSignal.timeout(25_000);
      const stream = adapter.sendStream({ ...minimalReq, stream: true }, { signal: streamSignal });
      const rawStreamOutput = await readStreamToString(stream);
      expect(rawStreamOutput).toBeString();
      expect(rawStreamOutput.length).toBeGreaterThan(0);
      if (
        rawStreamOutput.includes('"type":"error"') ||
        rawStreamOutput.includes('"type": "error"')
      ) {
        if (
          rawStreamOutput.includes("high demand") ||
          rawStreamOutput.includes("exhausted") ||
          rawStreamOutput.includes("quota") ||
          rawStreamOutput.includes("503") ||
          rawStreamOutput.includes("429")
        ) {
          console.warn(`[E2E] ${adapter.tier} stream returned transient error payload`);
          return;
        }
      }
      expect(rawStreamOutput).not.toContain('"type": "error"');
      expect(rawStreamOutput).not.toContain('"type":"error"');
    }
  } catch (err: any) {
    if (isTransientError(err)) {
      console.warn(
        `[E2E] ${adapter.tier} skipped due to transient upstream status: ${err.message}`,
      );
      return;
    }
    throw err;
  }
}

describe.skipIf(!shouldRunE2E)("E2E Provider Adapter Tests", () => {
  const E2E_TIMEOUT_MS = 30_000;

  const groqEnabled = isKeyValid(config.groq.apiKey);
  test.skipIf(!groqEnabled)(
    "groq adapter direct connection",
    async () => {
      await testAdapter(groqAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const geminiEnabled = isKeyValid(config.gemini.apiKey);
  test.skipIf(!geminiEnabled)(
    "gemini adapter direct connection",
    async () => {
      await testAdapter(geminiAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const openrouterEnabled = isKeyValid(config.openrouter.apiKey);
  test.skipIf(!openrouterEnabled)(
    "openrouter adapter direct connection",
    async () => {
      await testAdapter(openrouterAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const cerebrasEnabled = isKeyValid(config.cerebras.apiKey);
  test.skipIf(!cerebrasEnabled)(
    "cerebras adapter direct connection",
    async () => {
      await testAdapter(cerebrasAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const mistralEnabled = isKeyValid(config.mistral.apiKey);
  test.skipIf(!mistralEnabled)(
    "mistral adapter direct connection",
    async () => {
      await testAdapter(mistralAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const nvidiaEnabled = isKeyValid(config.nvidia.apiKey);
  test.skipIf(!nvidiaEnabled)(
    "nvidia adapter direct connection",
    async () => {
      await testAdapter(nvidiaAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const cloudflareEnabled =
    isKeyValid(config.cloudflare.apiToken) && isKeyValid(config.cloudflare.accountId);
  test.skipIf(!cloudflareEnabled)(
    "cloudflare adapter direct connection",
    async () => {
      await testAdapter(cloudflareAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const cohereEnabled = isKeyValid(config.cohere.apiKey);
  test.skipIf(!cohereEnabled)(
    "cohere adapter direct connection",
    async () => {
      await testAdapter(cohereAdapter);
    },
    E2E_TIMEOUT_MS,
  );

  const localEnabled = Boolean(process.env.LOCAL_E2E === "true" || process.env.LOCAL_E2E === "1");
  test.skipIf(!localEnabled)(
    "local adapter direct connection",
    async () => {
      await testAdapter(localAdapter);
    },
    E2E_TIMEOUT_MS,
  );
});
