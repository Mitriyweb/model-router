import { config } from "./config";
import type { PolicyRule } from "./types";

export const POLICIES: PolicyRule[] = [
  {
    name: "exact-repeat-from-cache",
    description: "Serve exact repeat requests from in-memory cache without calling an LLM",
    match: () => !config.cacheDisabled,
    strategy: { kind: "deterministic", resolver: "cache" },
  },
  // Example rules to customize:
  // {
  //   name: "force-gemini-large-context",
  //   match: (req) => (req.messages.length > 20),
  //   strategy: { kind: "tier", tier: "gemini" },
  // },
  // {
  //   name: "force-local-private",
  //   match: (req) => req.systemPrompt.includes("CONFIDENTIAL"),
  //   strategy: { kind: "local" },
  // },
];
