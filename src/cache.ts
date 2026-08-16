import type { AnthropicResponse, NormalizedRequest } from "./types";

const memoryCache = new Map<string, AnthropicResponse>();

export async function cacheKey(req: NormalizedRequest): Promise<string> {
  const payload = JSON.stringify({
    systemPrompt: req.systemPrompt,
    messages: req.messages,
    tools: req.tools,
    temperature: req.temperature,
  });

  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getCached(key: string): AnthropicResponse | undefined {
  return memoryCache.get(key);
}

export function setCached(key: string, response: AnthropicResponse): void {
  memoryCache.set(key, response);
}

export function clearCache(): void {
  memoryCache.clear();
}
