import { describe, expect, it } from "bun:test";
import { pruneNormalizedRequest } from "../src/pruner";
import type { NormalizedRequest } from "../src/types";

describe("pruner", () => {
  it("leaves small requests intact", () => {
    const req: NormalizedRequest = {
      systemPrompt: "System prompt",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
      tools: [],
      stream: false,
    };

    const pruned = pruneNormalizedRequest(req, 1000);
    expect(pruned).toEqual(req);
  });

  it("prunes older messages while preserving recent messages and system prompt", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        `This is message number ${i + 1} with some long text to increase token count. `.repeat(10),
    }));

    const req: NormalizedRequest = {
      systemPrompt: "You are a helpful assistant.",
      messages,
      tools: [],
      stream: false,
    };

    const pruned = pruneNormalizedRequest(req, 200, 2);
    expect(pruned.messages.length).toBeLessThan(messages.length);
    expect(pruned.systemPrompt).toBe(req.systemPrompt);
    // Preserves recent messages
    expect(pruned.messages[pruned.messages.length - 1]).toEqual(messages[messages.length - 1]);
  });

  it("preserves tool call sequences during pruning", () => {
    const req: NormalizedRequest = {
      systemPrompt: "You have tools.",
      messages: [
        { role: "user", content: "Turn 1" },
        { role: "assistant", content: "Turn 2" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_123", name: "search", input: { query: "test" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_123", content: "result data" }],
        },
        { role: "assistant", content: "Final response" },
      ],
      tools: [{ name: "search", description: "search tool", input_schema: {} }],
      stream: false,
    };

    const pruned = pruneNormalizedRequest(req, 100, 2);
    // Should not drop tool_use while keeping tool_result
    const toolResults = pruned.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
    );
    const toolUses = pruned.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : [],
    );

    if (toolResults.length > 0) {
      expect(toolUses.length).toBeGreaterThan(0);
    }
  });
});
