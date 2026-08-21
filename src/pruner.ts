import { countTokens } from "./tokenizer";
import type { AnthropicMessage, NormalizedRequest } from "./types";

export function estimateMessageTokens(message: AnthropicMessage): number {
  if (typeof message.content === "string") {
    return countTokens(message.content);
  }
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      text += `tool:${block.name}:${JSON.stringify(block.input)}`;
    } else if (block.type === "tool_result") {
      text += `result:${block.tool_use_id}:${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`;
    }
  }
  return countTokens(text);
}

export function estimateRequestTokens(req: NormalizedRequest): number {
  let text = req.systemPrompt ?? "";
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      text += `\n${m.content}`;
    } else {
      text += `\n${JSON.stringify(m.content)}`;
    }
  }
  text += JSON.stringify(req.tools);
  return countTokens(text);
}

function isValidMessageSequence(messages: AnthropicMessage[]): boolean {
  if (messages.length === 0) return true;
  // Upstream APIs require message history to start with a user message
  if (messages[0].role !== "user") return false;

  // Track tool_use IDs and tool_result references to ensure complete pairs
  const toolUses = new Map<string, number>();
  const toolResults = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") {
          toolUses.set(b.id, i);
        } else if (b.type === "tool_result") {
          toolResults.add(b.tool_use_id);
          // Tool result must have a preceding tool_use
          if (!toolUses.has(b.tool_use_id)) {
            return false;
          }
        }
      }
    }
  }

  // Ensure every tool_use in the history has a matching tool_result
  for (const toolUseId of toolUses.keys()) {
    if (!toolResults.has(toolUseId)) {
      return false;
    }
  }

  return true;
}

/**
 * Intelligently prunes older message history from a request to fit within targetTokenLimit.
 * Preserves:
 * - systemPrompt
 * - tools definition
 * - recent turns (minKeepRecent)
 * - tool_use / tool_result pairs
 * - starts with a user role message
 */
export function pruneNormalizedRequest(
  req: NormalizedRequest,
  targetTokenLimit: number,
  minKeepRecent = 2,
): NormalizedRequest {
  if (estimateRequestTokens(req) <= targetTokenLimit || req.messages.length <= minKeepRecent) {
    return req;
  }

  const messages = [...req.messages];

  while (messages.length > minKeepRecent) {
    if (estimateRequestTokens({ ...req, messages }) <= targetTokenLimit) {
      break;
    }

    let removed = false;
    // Attempt removing messages from the front while keeping a valid sequence
    for (let count = 1; count <= messages.length - minKeepRecent; count++) {
      const candidate = messages.slice(count);
      if (isValidMessageSequence(candidate)) {
        messages.splice(0, count);
        removed = true;
        break;
      }
    }

    if (!removed) {
      break; // Cannot prune further while keeping valid tool pairs and user start role
    }
  }

  return {
    ...req,
    messages,
  };
}
