import { cohereAdapter } from "../adapters/cohere";
import { geminiAdapter } from "../adapters/gemini";
import { config } from "../config";
import type { ProviderAdapter, TierName } from "../types";
import { PROVIDERS, type ProviderDefinition } from "./definitions";
import { createOpenAIAdapter } from "./openai";

function buildAdapter(tier: TierName, definition: ProviderDefinition): ProviderAdapter {
  switch (definition.protocol) {
    case "gemini":
      return geminiAdapter;
    case "cohere":
      return cohereAdapter;
    case "openai":
      return createOpenAIAdapter(tier, definition);
  }
}

const definitions = Object.entries(PROVIDERS) as [TierName, ProviderDefinition][];

/** Ready adapters for every provider in the registry. */
export const adapters = Object.fromEntries(
  definitions.map(([tier, definition]) => [tier, buildAdapter(tier, definition)]),
) as Record<TierName, ProviderAdapter>;

/** A provider is usable when every credential declared in its definition is set. */
export function hasCredentials(tier: TierName): boolean {
  const credentials = (PROVIDERS[tier] as ProviderDefinition).credentials ?? ["apiKey"];
  return credentials.every((field) => Boolean(config[tier][field]));
}

export { PROVIDERS, VALID_TIERS } from "./definitions";
export type { ProviderConfig, ProviderDefinition } from "./definitions";
