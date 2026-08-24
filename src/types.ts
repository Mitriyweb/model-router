export type Role = "user" | "assistant" | "system";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown; is_error?: boolean };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | { type: "text"; text: string }[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  usage: AnthropicUsage;
}

export interface NormalizedRequest {
  systemPrompt: string;
  messages: AnthropicMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream: boolean;
  signal?: AbortSignal;
}

export type TierName =
  | "groq"
  | "gemini"
  | "openrouter"
  | "cerebras"
  | "mistral"
  | "nvidia"
  | "cloudflare"
  | "cohere"
  | "local";
export type ResolvedBy = TierName | "deterministic";

export interface TierLimits {
  rpm: number;
  tpm: number;
  rpd: number;
}

export interface ProviderAdapter {
  tier: TierName;
  canHandle(req: NormalizedRequest, estimatedTokens: number): boolean;
  send(req: NormalizedRequest, opts?: { signal?: AbortSignal }): Promise<AnthropicResponse>;
  sendStream?(req: NormalizedRequest, opts?: { signal?: AbortSignal }): ReadableStream<Uint8Array>;
}

export type PolicyStrategy =
  | { kind: "deterministic"; resolver: string }
  | { kind: "tier"; tier: TierName }
  | { kind: "local" };

export interface PolicyRule {
  name: string;
  description?: string;
  match: (req: NormalizedRequest) => boolean;
  strategy: PolicyStrategy;
}
