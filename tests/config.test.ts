import { describe, expect, it } from "bun:test";
import { loadProviderConfig, validateConfigEnv } from "../src/config/validation";
import { VALID_TIERS } from "../src/providers/definitions";

describe("config validation", () => {
  it("derives defaults from the provider registry", () => {
    const result = validateConfigEnv({});

    expect(result.port).toBe(8787);
    expect(result.host).toBe("127.0.0.1");
    expect(result.authToken).toBeUndefined();
    expect(result.fallbackOrder).toEqual(VALID_TIERS);
    expect(Object.keys(result.providers)).toEqual(VALID_TIERS);
    expect(result.providers.cerebras.model).toBe("llama-3.3-70b");
    expect(result.providers.gemini.model).toBe("gemini-3.7-flash");
  });

  it("reports every invalid value in one readable error", () => {
    let error: Error | undefined;
    try {
      validateConfigEnv({
        PORT: "not-a-port",
        ROUTER_DISABLE_CACHE: "maybe",
        GROQ_TPM: "-1",
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("Invalid configuration:");
    expect(error?.message).toContain("PORT must be an integer");
    expect(error?.message).toContain("ROUTER_DISABLE_CACHE must be one of");
    expect(error?.message).toContain("GROQ_TPM must be at least 0");
  });

  it("skips unknown fallback tiers with a warning unless strict mode is enabled", () => {
    const permissive = validateConfigEnv({ FALLBACK_ORDER: "groq,unknown-tier,local" });
    expect(permissive.fallbackOrder).toEqual(["groq", "local"]);
    expect(permissive.warnings.join(" ")).toContain("unknown-tier");

    let error: Error | undefined;
    try {
      validateConfigEnv({
        FALLBACK_ORDER: "groq,unknown-tier,local",
        ROUTER_STRICT_FALLBACK_ORDER: "true",
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toContain("FALLBACK_ORDER contains unknown tier(s): unknown-tier");
    expect(error?.message).toContain(`Valid tiers: ${VALID_TIERS.join(", ")}`);
  });

  it("clamps numeric limits into safe ranges", () => {
    const result = validateConfigEnv({
      GROQ_TPM: "999999999999",
      GROQ_RPM: "0",
      ROUTER_MAX_CONTEXT_TOKENS: "999999999",
    });

    expect(result.providers.groq.limits.tpm).toBe(1_000_000_000);
    expect(result.providers.groq.limits.rpm).toBe(0);
    expect(result.routerMaxContextTokens).toBe(10_000_000);
  });

  it("rejects malformed URLs and whitespace-only hosts", () => {
    let error: Error | undefined;
    try {
      validateConfigEnv({
        ROUTER_HOST: " 127.0.0.1 ",
        OPENROUTER_BASE_URL: "ftp://example.com",
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error?.message).toContain("ROUTER_HOST must not contain leading or trailing spaces");
    expect(error?.message).toContain("OPENROUTER_BASE_URL must use http or https");
  });

  it("loads provider credentials and extras by env prefix", () => {
    const definition = {
      label: "Test",
      description: "test provider",
      protocol: "openai" as const,
      envPrefix: "TESTPROVIDER",
      credentials: ["apiToken", "accountId"] as const,
      baseUrlDefault: "https://example.com/v1",
      modelDefault: "test-model",
      limits: { rpm: 1, tpm: 2, rpd: 3 },
      envExtras: ["provider" as const],
    };
    const errors: string[] = [];
    const cfg = loadProviderConfig(
      definition,
      (name) => {
        const values: Record<string, string> = {
          TESTPROVIDER_API_TOKEN: "token",
          TESTPROVIDER_ACCOUNT_ID: "account",
          TESTPROVIDER_PROVIDER: "upstream",
        };
        return values[name];
      },
      errors,
    );

    expect(cfg.apiToken).toBe("token");
    expect(cfg.accountId).toBe("account");
    expect(cfg.provider).toBe("upstream");
    expect(cfg.limits).toEqual({ rpm: 1, tpm: 2, rpd: 3 });
    expect(errors).toEqual([]);
  });
});
