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

async function testAdapter(adapter: ProviderAdapter) {
  // Test unary send
  const res = await adapter.send(minimalReq);
  expect(res).toBeDefined();
  expect(res.id).toBeString();
  expect(res.role).toBe("assistant");
  expect(Array.isArray(res.content)).toBeTrue();
  expect(res.content.length).toBeGreaterThan(0);
  expect(res.usage).toBeDefined();

  // Test streaming sendStream
  if (adapter.sendStream) {
    const stream = adapter.sendStream({ ...minimalReq, stream: true });
    const rawStreamOutput = await readStreamToString(stream);
    expect(rawStreamOutput).toBeString();
    expect(rawStreamOutput.length).toBeGreaterThan(0);
  }
}

describe.skipIf(!shouldRunE2E)("E2E Provider Adapter Tests", () => {
  const groqEnabled = isKeyValid(config.groq.apiKey);
  test.skipIf(!groqEnabled)("groq adapter direct connection", async () => {
    await testAdapter(groqAdapter);
  });

  const geminiEnabled = isKeyValid(config.gemini.apiKey);
  test.skipIf(!geminiEnabled)("gemini adapter direct connection", async () => {
    await testAdapter(geminiAdapter);
  });

  const openrouterEnabled = isKeyValid(config.openrouter.apiKey);
  test.skipIf(!openrouterEnabled)("openrouter adapter direct connection", async () => {
    await testAdapter(openrouterAdapter);
  });

  const cerebrasEnabled = isKeyValid(config.cerebras.apiKey);
  test.skipIf(!cerebrasEnabled)("cerebras adapter direct connection", async () => {
    await testAdapter(cerebrasAdapter);
  });

  const mistralEnabled = isKeyValid(config.mistral.apiKey);
  test.skipIf(!mistralEnabled)("mistral adapter direct connection", async () => {
    await testAdapter(mistralAdapter);
  });

  const nvidiaEnabled = isKeyValid(config.nvidia.apiKey);
  test.skipIf(!nvidiaEnabled)("nvidia adapter direct connection", async () => {
    await testAdapter(nvidiaAdapter);
  });

  const cloudflareEnabled =
    isKeyValid(config.cloudflare.apiToken) && isKeyValid(config.cloudflare.accountId);
  test.skipIf(!cloudflareEnabled)("cloudflare adapter direct connection", async () => {
    await testAdapter(cloudflareAdapter);
  });

  const cohereEnabled = isKeyValid(config.cohere.apiKey);
  test.skipIf(!cohereEnabled)("cohere adapter direct connection", async () => {
    await testAdapter(cohereAdapter);
  });

  const localEnabled = Boolean(process.env.LOCAL_E2E === "true" || process.env.LOCAL_E2E === "1");
  test.skipIf(!localEnabled)("local adapter direct connection", async () => {
    await testAdapter(localAdapter);
  });
});
