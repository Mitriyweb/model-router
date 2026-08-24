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

export function truncateText(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text;
  if (maxTokens <= 10) return "[...content pruned...]";

  const notice = "\n[...content pruned...]\n";
  const noticeTokens = countTokens(notice);
  if (maxTokens <= noticeTokens) return "[pruned]";

  let low = 0;
  let high = text.length;
  let best = notice;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const headLen = Math.floor(mid * 0.7);
    const tailLen = mid - headLen;
    const candidate = `${text.slice(0, headLen)}${notice}${text.slice(text.length - tailLen)}`;

    if (countTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function cloneRequest(req: NormalizedRequest): NormalizedRequest {
  return {
    ...req,
    systemPrompt: req.systemPrompt,
    tools: req.tools ? JSON.parse(JSON.stringify(req.tools)) : undefined,
    messages: req.messages.map((m) => {
      if (typeof m.content === "string") {
        return { ...m };
      }
      return {
        ...m,
        content: m.content.map((b) => {
          if (b.type === "tool_result" && Array.isArray(b.content)) {
            return {
              ...b,
              content: b.content.map((sb) => ({ ...sb })),
            };
          }
          return { ...b };
        }),
      };
    }),
  };
}

interface TextSlot {
  get: () => string;
  set: (val: string) => void;
}

function collectTextSlots(req: NormalizedRequest): TextSlot[] {
  const slots: TextSlot[] = [];

  if (req.systemPrompt) {
    slots.push({
      get: () => req.systemPrompt ?? "",
      set: (val: string) => {
        req.systemPrompt = val;
      },
    });
  }

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      const msg = m;
      slots.push({
        get: () => (typeof msg.content === "string" ? msg.content : ""),
        set: (val: string) => {
          msg.content = val;
        },
      });
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text") {
          const b = block;
          slots.push({
            get: () => b.text,
            set: (val: string) => {
              b.text = val;
            },
          });
        } else if (block.type === "tool_result") {
          if (typeof block.content === "string") {
            const b = block;
            slots.push({
              get: () => (typeof b.content === "string" ? b.content : ""),
              set: (val: string) => {
                b.content = val;
              },
            });
          } else if (Array.isArray(block.content)) {
            for (const subBlock of block.content) {
              if (subBlock.type === "text") {
                const sb = subBlock;
                slots.push({
                  get: () => sb.text,
                  set: (val: string) => {
                    sb.text = val;
                  },
                });
              }
            }
          }
        }
      }
    }
  }

  return slots;
}

/**
 * Intelligently prunes older message history and text contents from a request to fit within targetTokenLimit.
 * Preserves:
 * - systemPrompt structure
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
  if (estimateRequestTokens(req) <= targetTokenLimit) {
    return req;
  }

  const messages = [...req.messages];

  // Step 1: Attempt message history level pruning
  if (messages.length > minKeepRecent) {
    while (messages.length > minKeepRecent) {
      if (estimateRequestTokens({ ...req, messages }) <= targetTokenLimit) {
        break;
      }

      let removed = false;
      for (let count = 1; count <= messages.length - minKeepRecent; count++) {
        const candidate = messages.slice(count);
        if (isValidMessageSequence(candidate)) {
          messages.splice(0, count);
          removed = true;
          break;
        }
      }

      if (!removed) {
        break;
      }
    }
  }

  let currentReq: NormalizedRequest = {
    ...req,
    messages,
  };

  if (estimateRequestTokens(currentReq) <= targetTokenLimit) {
    return currentReq;
  }

  // Step 2: Content-level truncation if still exceeding limit
  currentReq = cloneRequest(currentReq);
  let iterations = 0;

  while (estimateRequestTokens(currentReq) > targetTokenLimit && iterations < 5) {
    iterations++;
    const currentTokens = estimateRequestTokens(currentReq);
    const excess = currentTokens - targetTokenLimit + 10;

    const slots = collectTextSlots(currentReq);
    if (slots.length === 0) break;

    const slotData = slots.map((s) => ({
      slot: s,
      tokens: countTokens(s.get()),
    }));

    let eligible = slotData.filter((d) => d.tokens > 50);
    if (eligible.length === 0) {
      eligible = slotData.filter((d) => d.tokens > 5);
    }
    if (eligible.length === 0) break;

    const totalEligibleTokens = eligible.reduce((sum, d) => sum + d.tokens, 0);

    for (const d of eligible) {
      const share = d.tokens / totalEligibleTokens;
      const reduction = Math.ceil(excess * share);
      const targetTokens = Math.max(5, d.tokens - reduction);
      const truncated = truncateText(d.slot.get(), targetTokens);
      d.slot.set(truncated);
    }
  }

  return currentReq;
}
