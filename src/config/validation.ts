import {
  PROVIDERS,
  type ProviderConfig,
  type ProviderDefinition,
  VALID_TIERS,
} from "../providers/definitions";
import type { TierName } from "../types";

export type EnvReader = (name: string) => string | undefined;
export type EnvSource = EnvReader | Record<string, string | undefined>;

export function toEnvReader(source: EnvSource = process.env): EnvReader {
  return typeof source === "function" ? source : (name) => source[name];
}

export interface ValidatedConfig {
  port: number;
  host: string;
  authToken?: string;
  stateFile: string;
  fallbackOrder: TierName[];
  hasCustomFallbackOrder: boolean;
  cacheDisabled: boolean;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  routerMaxContextTokens: number;
  providers: Record<TierName, ProviderConfig>;
  /** Non-fatal issues, e.g. unknown fallback tiers skipped in permissive mode. */
  warnings: string[];
}

const MAX_LIMITS = {
  rpm: 100_000,
  tpm: 1_000_000_000,
  rpd: 100_000_000,
} as const;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function parseInteger(
  env: EnvReader,
  name: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = env(name);
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(`${name} must be an integer (got "${raw}")`);
    return fallback;
  }
  if (value < min) {
    errors.push(`${name} must be at least ${min} (got ${value})`);
    return min;
  }
  return Math.min(value, max);
}

function parseBoolean(env: EnvReader, name: string, errors: string[]): boolean {
  const raw = env(name);
  if (raw === undefined || raw.trim() === "") return false;

  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;

  errors.push(`${name} must be one of ${[...TRUTHY, ...FALSY].join(", ")} (got "${raw}")`);
  return false;
}

function validateUrl(env: EnvReader, name: string, errors: string[]): void {
  const raw = env(name);
  if (raw === undefined || raw.trim() === "") return;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${name} must use http or https (got "${url.protocol}")`);
    }
  } catch {
    errors.push(`${name} must be a valid URL (got "${raw}")`);
  }
}

function parseFallbackOrder(
  env: EnvReader,
  errors: string[],
  warnings: string[],
): { order: TierName[]; custom: boolean } {
  const raw = env("FALLBACK_ORDER")?.trim();
  if (!raw) return { order: [...VALID_TIERS], custom: false };

  const tiers = raw
    .split(",")
    .map((tier) => tier.trim())
    .filter(Boolean);
  if (tiers.length === 0) return { order: [...VALID_TIERS], custom: false };

  const invalid = tiers.filter((tier) => !VALID_TIERS.includes(tier as TierName));
  if (invalid.length > 0) {
    const message = `FALLBACK_ORDER contains unknown tier(s): ${invalid.join(", ")}. Valid tiers: ${VALID_TIERS.join(", ")}`;
    if (parseBoolean(env, "ROUTER_STRICT_FALLBACK_ORDER", errors)) {
      errors.push(message);
    } else {
      warnings.push(`${message} — these tiers will be ignored.`);
    }
  }

  return { order: tiers.filter((tier) => !invalid.includes(tier)) as TierName[], custom: true };
}

/**
 * Resolve one provider from the environment using the registry's naming
 * convention: `<PREFIX>_API_KEY`, `_API_TOKEN`, `_ACCOUNT_ID`, `_PROVIDER`,
 * `_BASE_URL`, `_MODEL`, `_RPM`, `_TPM`, `_RPD`.
 */
export function loadProviderConfig(
  definition: ProviderDefinition,
  env: EnvReader = (name) => process.env[name],
  errors: string[] = [],
): ProviderConfig {
  const prefix = definition.envPrefix;

  validateUrl(env, `${prefix}_BASE_URL`, errors);

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
      rpm: parseInteger(env, `${prefix}_RPM`, definition.limits.rpm, 0, MAX_LIMITS.rpm, errors),
      tpm: parseInteger(env, `${prefix}_TPM`, definition.limits.tpm, 0, MAX_LIMITS.tpm, errors),
      rpd: parseInteger(env, `${prefix}_RPD`, definition.limits.rpd, 0, MAX_LIMITS.rpd, errors),
    },
  };
}

/** Validate and resolve every environment value before the server starts. */
export function validateConfigEnv(source: EnvSource = process.env): ValidatedConfig {
  const env = toEnvReader(source);
  const errors: string[] = [];
  const warnings: string[] = [];

  const port = parseInteger(env, "PORT", 8787, 1, 65_535, errors);
  const rawHost = env("ROUTER_HOST");
  const host = rawHost?.trim() || "127.0.0.1";
  if (rawHost !== undefined && rawHost !== rawHost.trim()) {
    errors.push("ROUTER_HOST must not contain leading or trailing spaces");
  }

  const authToken = env("ROUTER_AUTH_TOKEN")?.trim() || undefined;
  const stateFile = env("RATE_LIMIT_STATE_FILE")?.trim() || ".router-state.json";
  const cacheDisabled = parseBoolean(env, "ROUTER_DISABLE_CACHE", errors);
  const cacheTtlMs = parseInteger(env, "ROUTER_CACHE_TTL_MS", 600_000, 1, 86_400_000, errors);
  const cacheMaxEntries = parseInteger(env, "ROUTER_CACHE_MAX_ENTRIES", 500, 1, 100_000, errors);
  const routerMaxContextTokens = parseInteger(
    env,
    "ROUTER_MAX_CONTEXT_TOKENS",
    128_000,
    1,
    10_000_000,
    errors,
  );
  const fallback = parseFallbackOrder(env, errors, warnings);

  const providers = Object.fromEntries(
    Object.entries(PROVIDERS).map(([tier, definition]) => [
      tier,
      loadProviderConfig(definition as ProviderDefinition, env, errors),
    ]),
  ) as Record<TierName, ProviderConfig>;

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    port,
    host,
    authToken,
    stateFile,
    fallbackOrder: fallback.order,
    hasCustomFallbackOrder: fallback.custom,
    cacheDisabled,
    cacheTtlMs,
    cacheMaxEntries,
    routerMaxContextTokens,
    providers,
    warnings,
  };
}
