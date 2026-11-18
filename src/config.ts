import "./env";
import { PROVIDERS, type ProviderConfig, type ProviderDefinition } from "./providers/definitions";
import type { TierName } from "./types";

export interface Config extends Record<TierName, ProviderConfig> {
  port: number;
  fallbackOrder: TierName[];
  hasCustomFallbackOrder: boolean;
  cacheDisabled: boolean;
  routerMaxContextTokens: number;
}

const defaultFallbackOrder: TierName[] = Object.keys(PROVIDERS) as TierName[];

function parseFallbackOrder(value?: string): TierName[] {
  const raw = value
    ?.split(",")
    .map((tier) => tier.trim())
    .filter(Boolean) as string[];

  if (!raw || raw.length === 0) return defaultFallbackOrder;

  const normalized = raw as TierName[];
  return normalized;
}

const parseBoolean = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
};

/**
 * Resolve one provider from the environment using the registry's naming
 * convention: `<PREFIX>_API_KEY`, `_API_TOKEN`, `_ACCOUNT_ID`, `_PROVIDER`,
 * `_BASE_URL`, `_MODEL`, `_RPM`, `_TPM`, `_RPD`.
 */
export function loadProviderConfig(definition: ProviderDefinition): ProviderConfig {
  const prefix = definition.envPrefix;
  const env = (name: string) => process.env[name];

  const baseUrlDefault =
    typeof definition.baseUrlDefault === "function"
      ? definition.baseUrlDefault(env)
      : definition.baseUrlDefault;

  return {
    apiKey: env(`${prefix}_API_KEY`) ?? "",
    apiToken: env(`${prefix}_API_TOKEN`) ?? "",
    accountId: env(`${prefix}_ACCOUNT_ID`) ?? "",
    provider: env(`${prefix}_PROVIDER`) ?? "",
    baseUrl: env(`${prefix}_BASE_URL`) ?? baseUrlDefault,
    model: env(`${prefix}_MODEL`) ?? definition.modelDefault,
    limits: {
      rpm: Number(env(`${prefix}_RPM`) ?? definition.limits.rpm),
      tpm: Number(env(`${prefix}_TPM`) ?? definition.limits.tpm),
      rpd: Number(env(`${prefix}_RPD`) ?? definition.limits.rpd),
    },
  };
}

const definitions = Object.entries(PROVIDERS) as [TierName, ProviderDefinition][];

const providers = Object.fromEntries(
  definitions.map(([tier, definition]) => [tier, loadProviderConfig(definition)]),
) as Record<TierName, ProviderConfig>;

export const config: Config = {
  port: Number(process.env.PORT ?? 8787),
  fallbackOrder: parseFallbackOrder(process.env.FALLBACK_ORDER),
  hasCustomFallbackOrder: Boolean(process.env.FALLBACK_ORDER?.trim()),
  cacheDisabled: parseBoolean(process.env.ROUTER_DISABLE_CACHE),
  routerMaxContextTokens: Number(process.env.ROUTER_MAX_CONTEXT_TOKENS ?? 128_000),
  ...providers,
};
