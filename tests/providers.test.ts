import { describe, expect, it } from "bun:test";
import { config } from "../src/config";
import { PROVIDERS, VALID_TIERS, adapters, hasCredentials } from "../src/providers";

describe("provider registry", () => {
  it("derives tiers, adapters and config from the registry", () => {
    expect(VALID_TIERS as readonly string[]).toEqual(Object.keys(PROVIDERS));
    expect(Object.keys(adapters)).toEqual(VALID_TIERS);

    for (const tier of VALID_TIERS) {
      expect(config[tier]).toBeDefined();
      expect(adapters[tier].tier).toBe(tier);
    }
  });

  it("requires every declared credential", () => {
    const originalToken = config.cloudflare.apiToken;
    const originalAccount = config.cloudflare.accountId;

    try {
      config.cloudflare.apiToken = "";
      config.cloudflare.accountId = "account";
      expect(hasCredentials("cloudflare")).toBe(false);

      config.cloudflare.apiToken = "token";
      config.cloudflare.accountId = "";
      expect(hasCredentials("cloudflare")).toBe(false);

      config.cloudflare.apiToken = "token";
      config.cloudflare.accountId = "account";
      expect(hasCredentials("cloudflare")).toBe(true);
    } finally {
      config.cloudflare.apiToken = originalToken;
      config.cloudflare.accountId = originalAccount;
    }
  });

  it("treats keyless providers as always configured", () => {
    expect(hasCredentials("local")).toBe(true);
  });
});
