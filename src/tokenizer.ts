import { encode } from "gpt-tokenizer";

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
