/**
 * Single source of truth for every provider.
 *
 * Everything provider-specific lives here: identity, protocol, env var naming,
 * defaults, rate limits and header quirks. Adding a provider means adding one
 * entry below — config, adapters, credential checks and the `/v1/models` and
 * `/v1/providers` endpoints all derive from this registry.
 */

export interface ProviderLimits {
  rpm: number;
  tpm: number;
  rpd: number;
}

export type ProviderProtocol = "openai" | "gemini" | "cohere";

/** Runtime config fields that can act as credentials. */
export type CredentialField = "apiKey" | "apiToken" | "accountId";

export type EnvReader = (name: string) => string | undefined;

export interface ProviderConfig {
  apiKey: string;
  apiToken: string;
  accountId: string;
  /** Upstream routing hint (Hugging Face Inference Providers). */
  provider: string;
  baseUrl: string;
  model: string;
  limits: ProviderLimits;
}

export interface ProviderDefinition {
  /** Human-readable name used in docs and errors. */
  label: string;
  /** Short description for generated `.env.example` sections. */
  description: string;
  protocol: ProviderProtocol;
  /** Prefix for generated env vars: `<PREFIX>_API_KEY`, `_BASE_URL`, `_MODEL`, `_RPM`, ... */
  envPrefix: string;
  /** Config fields that must all be non-empty for the provider to be usable. Defaults to `["apiKey"]`. */
  credentials?: readonly CredentialField[];
  baseUrlDefault: string | ((env: EnvReader) => string);
  modelDefault: string;
  limits: ProviderLimits;
  /**
   * Context window used by `canHandle`:
   * - `"router"` — follow `ROUTER_MAX_CONTEXT_TOKENS`
   * - a number — fixed window
   * - omitted — the OpenAI-compatible default (128k)
   */
  contextLimit?: "router" | number;
  /** Provider can only serve requests when a model is configured. */
  requiresModel?: boolean;
  /** Additional generic config fields exposed as `<PREFIX>_<NAME>` env vars. */
  envExtras?: readonly "provider"[];
  /** Extra headers derived from the resolved config. */
  extraHeaders?: (cfg: ProviderConfig) => Record<string, string>;
}

export const PROVIDERS = {
  cerebras: {
    label: "Cerebras",
    description: "Ultra-fast Llama inference (https://cloud.cerebras.ai)",
    protocol: "openai",
    envPrefix: "CEREBRAS",
    baseUrlDefault: "https://api.cerebras.ai/v1",
    modelDefault: "llama-3.3-70b",
    limits: { rpm: 30, tpm: 60_000, rpd: 14_400 },
    contextLimit: "router",
  },
  groq: {
    label: "Groq",
    description: "Fast free-tier inference (https://console.groq.com)",
    protocol: "openai",
    envPrefix: "GROQ",
    baseUrlDefault: "https://api.groq.com/openai/v1",
    modelDefault: "llama-3.3-70b-versatile",
    limits: { rpm: 30, tpm: 6_000, rpd: 14_400 },
    contextLimit: "router",
  },
  gemini: {
    label: "Gemini",
    description: "Google Gemini free tier (https://aistudio.google.com)",
    protocol: "gemini",
    envPrefix: "GEMINI",
    baseUrlDefault: "https://generativelanguage.googleapis.com/v1beta",
    modelDefault: "gemini-3.7-flash",
    limits: { rpm: 15, tpm: 1_000_000, rpd: 1_500 },
  },
  openrouter: {
    label: "OpenRouter",
    description: "Free models via one endpoint (https://openrouter.ai)",
    protocol: "openai",
    envPrefix: "OPENROUTER",
    baseUrlDefault: "https://openrouter.ai/api/v1",
    modelDefault: "openrouter/free",
    limits: { rpm: 20, tpm: 40_000, rpd: 50 },
    contextLimit: "router",
    extraHeaders: () => ({
      "HTTP-Referer": "https://github.com/Mitriyweb/model-router",
      "X-Title": "model-router",
    }),
  },
  mistral: {
    label: "Mistral",
    description: "Mistral free tier (https://console.mistral.ai)",
    protocol: "openai",
    envPrefix: "MISTRAL",
    baseUrlDefault: "https://api.mistral.ai/v1",
    modelDefault: "codestral-latest",
    limits: { rpm: 2, tpm: 500_000, rpd: 1_000 },
    contextLimit: "router",
  },
  nvidia: {
    label: "NVIDIA NIM",
    description: "NVIDIA free inference (https://build.nvidia.com)",
    protocol: "openai",
    envPrefix: "NVIDIA",
    baseUrlDefault: "https://integrate.api.nvidia.com/v1",
    modelDefault: "meta/llama-3.3-70b-instruct",
    limits: { rpm: 40, tpm: 40_000, rpd: 1_000 },
  },
  huggingface: {
    label: "Hugging Face",
    description:
      "Inference Providers (https://huggingface.co/docs/api-inference/inference-providers)",
    protocol: "openai",
    envPrefix: "HF",
    baseUrlDefault: "https://router.huggingface.co/v1",
    modelDefault: "",
    limits: { rpm: 20, tpm: 40_000, rpd: 1_000 },
    contextLimit: "router",
    requiresModel: true,
    envExtras: ["provider"],
    extraHeaders: (cfg) => {
      const headers: Record<string, string> = {};
      if (cfg.provider) headers["x-hf-provider"] = cfg.provider;
      return headers;
    },
  },
  cloudflare: {
    label: "Cloudflare AI",
    description: "Workers AI free tier (https://dash.cloudflare.com)",
    protocol: "openai",
    envPrefix: "CLOUDFLARE",
    credentials: ["apiToken", "accountId"],
    baseUrlDefault: (env) =>
      `https://api.cloudflare.com/client/v4/accounts/${env("CLOUDFLARE_ACCOUNT_ID") ?? ""}/ai/v1`,
    modelDefault: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    limits: { rpm: 60, tpm: 50_000, rpd: 10_000 },
  },
  cohere: {
    label: "Cohere",
    description: "Command R+ tool-use API (https://dashboard.cohere.com)",
    protocol: "cohere",
    envPrefix: "COHERE",
    baseUrlDefault: "https://api.cohere.com/v2",
    modelDefault: "command-r-plus-08-2024",
    limits: { rpm: 10, tpm: 20_000, rpd: 100 },
  },
  local: {
    label: "Local",
    description: "Local OpenAI-compatible server (Ollama, llama.cpp, etc.)",
    protocol: "openai",
    envPrefix: "LOCAL",
    credentials: [],
    baseUrlDefault: "http://localhost:11434/v1",
    modelDefault: "qwen2.5-coder:7b",
    limits: { rpm: 120, tpm: 100_000, rpd: 100_000 },
  },
} as const satisfies Record<string, ProviderDefinition>;

export type ProviderId = keyof typeof PROVIDERS;

/** Registry keys in declaration order; the default fallback order. */
export const VALID_TIERS = Object.keys(PROVIDERS) as ProviderId[];
