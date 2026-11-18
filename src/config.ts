import "./env";
import { loadProviderConfig, validateConfigEnv } from "./config/validation";
import { log } from "./log";
import type { ProviderConfig } from "./providers/definitions";
import type { TierName } from "./types";

export { loadProviderConfig } from "./config/validation";
export type { EnvReader } from "./config/validation";

export interface Config extends Record<TierName, ProviderConfig> {
  port: number;
  host: string;
  authToken?: string;
  stateFile: string;
  fallbackOrder: TierName[];
  hasCustomFallbackOrder: boolean;
  cacheDisabled: boolean;
  routerMaxContextTokens: number;
}

const validated = validateConfigEnv();

for (const warning of validated.warnings) {
  log.warn(`[config] ${warning}`);
}

export const config: Config = {
  port: validated.port,
  host: validated.host,
  authToken: validated.authToken,
  stateFile: validated.stateFile,
  fallbackOrder: validated.fallbackOrder,
  hasCustomFallbackOrder: validated.hasCustomFallbackOrder,
  cacheDisabled: validated.cacheDisabled,
  routerMaxContextTokens: validated.routerMaxContextTokens,
  ...validated.providers,
};
