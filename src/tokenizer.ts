import { encode } from "gpt-tokenizer";
import type { NormalizedRequest } from "./types";

/**
 * Counts tokens using OpenAI cl100k_base tokenizer.
 * Consistent across all models for fair comparison and budget estimation.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Fallback if encoding throws on rare binary-like characters
    return Math.ceil(text.length / 4);
  }
}

/**
 * Estimates the token cost of a full normalized request: system prompt,
 * message history, and tool definitions.
 *
 * Single source of truth for both routing budgets and context pruning.
 */
export function estimateRequestTokens(req: NormalizedRequest): number {
  let text = req.systemPrompt ?? "";
  for (const m of req.messages) {
    text += `\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
  }
  text += JSON.stringify(req.tools);
  return countTokens(text);
}
