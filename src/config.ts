import type { TierLimits, TierName } from "./types";

export interface Config {
  port: number;
  fallbackOrder: TierName[];
  hasCustomFallbackOrder: boolean;
  cacheDisabled: boolean;
  routerMaxContextTokens: number;
  groq: {
    apiKey: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  gemini: {
    apiKey: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  openrouter: {
    apiKey: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  cerebras: {
    apiKey: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  mistral: {
    apiKey: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  nvidia: {
    apiKey: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  cloudflare: {
    apiToken: string;
    accountId: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  cohere: {
    apiKey: string;
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
  local: {
    baseUrl: string;
    model: string;
    limits: TierLimits;
  };
}

const defaultFallbackOrder: TierName[] = [
  "cerebras",
  "groq",
  "gemini",
  "openrouter",
  "mistral",
  "nvidia",
  "cloudflare",
  "cohere",
  "local",
];

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

export const config: Config = {
  port: Number(process.env.PORT ?? 8787),
  fallbackOrder: parseFallbackOrder(process.env.FALLBACK_ORDER),
  hasCustomFallbackOrder: Boolean(process.env.FALLBACK_ORDER?.trim()),
  cacheDisabled: parseBoolean(process.env.ROUTER_DISABLE_CACHE),
  routerMaxContextTokens: Number(process.env.ROUTER_MAX_CONTEXT_TOKENS ?? 128_000),
  groq: {
    apiKey: process.env.GROQ_API_KEY ?? "",
    baseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
    model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    limits: {
      rpm: Number(process.env.GROQ_RPM ?? 30),
      tpm: Number(process.env.GROQ_TPM ?? 6000),
      rpd: Number(process.env.GROQ_RPD ?? 14400),
    },
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
    limits: {
      rpm: Number(process.env.GEMINI_RPM ?? 15),
      tpm: Number(process.env.GEMINI_TPM ?? 1_000_000),
      rpd: Number(process.env.GEMINI_RPD ?? 1500),
    },
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    model: process.env.OPENROUTER_MODEL ?? "openrouter/free",
    limits: {
      rpm: Number(process.env.OPENROUTER_RPM ?? 20),
      tpm: Number(process.env.OPENROUTER_TPM ?? 40_000),
      rpd: Number(process.env.OPENROUTER_RPD ?? 50),
    },
  },
  cerebras: {
    apiKey: process.env.CEREBRAS_API_KEY ?? "",
    baseUrl: process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1",
    model: process.env.CEREBRAS_MODEL ?? "llama-3.3-70b",
    limits: {
      rpm: Number(process.env.CEREBRAS_RPM ?? 30),
      tpm: Number(process.env.CEREBRAS_TPM ?? 60_000),
      rpd: Number(process.env.CEREBRAS_RPD ?? 14400),
    },
  },
  mistral: {
    apiKey: process.env.MISTRAL_API_KEY ?? "",
    baseUrl: process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai/v1",
    model: process.env.MISTRAL_MODEL ?? "codestral-latest",
    limits: {
      rpm: Number(process.env.MISTRAL_RPM ?? 2),
      tpm: Number(process.env.MISTRAL_TPM ?? 500_000),
      rpd: Number(process.env.MISTRAL_RPD ?? 1000),
    },
  },
  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY ?? "",
    baseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    model: process.env.NVIDIA_MODEL ?? "meta/llama-3.3-70b-instruct",
    limits: {
      rpm: Number(process.env.NVIDIA_RPM ?? 40),
      tpm: Number(process.env.NVIDIA_TPM ?? 40_000),
      rpd: Number(process.env.NVIDIA_RPD ?? 1000),
    },
  },
  cloudflare: {
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    baseUrl:
      process.env.CLOUDFLARE_BASE_URL ??
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID ?? ""}/ai/v1`,
    model: process.env.CLOUDFLARE_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    limits: {
      rpm: Number(process.env.CLOUDFLARE_RPM ?? 60),
      tpm: Number(process.env.CLOUDFLARE_TPM ?? 50_000),
      rpd: Number(process.env.CLOUDFLARE_RPD ?? 10_000),
    },
  },
  cohere: {
    apiKey: process.env.COHERE_API_KEY ?? "",
    baseUrl: process.env.COHERE_BASE_URL ?? "https://api.cohere.com/v2",
    model: process.env.COHERE_MODEL ?? "command-r-plus-08-2024",
    limits: {
      rpm: Number(process.env.COHERE_RPM ?? 10),
      tpm: Number(process.env.COHERE_TPM ?? 20_000),
      rpd: Number(process.env.COHERE_RPD ?? 100),
    },
  },
  local: {
    baseUrl: process.env.LOCAL_BASE_URL ?? "http://localhost:11434/v1",
    model: process.env.LOCAL_MODEL ?? "qwen2.5-coder:7b",
    limits: {
      rpm: Number(process.env.LOCAL_RPM ?? 120),
      tpm: Number(process.env.LOCAL_TPM ?? 100_000),
      rpd: Number(process.env.LOCAL_RPD ?? 100_000),
    },
  },
};
