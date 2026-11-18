import { describe, expect, it } from "bun:test";
import { HttpError } from "../../src/server/http";
import { parseAnthropicRequest, parseOpenAIRequest } from "../../src/server/parsers";

describe("request body parsers", () => {
  it("rejects non-object Anthropic bodies with a format-specific message", () => {
    expect(() => parseAnthropicRequest(null, "anthropic")).toThrow(
      new HttpError(400, "invalid JSON body"),
    );
    expect(() => parseAnthropicRequest("nope", "openai")).toThrow(
      new HttpError(400, "Invalid JSON body"),
    );
  });

  it("normalizes Anthropic system blocks, messages, tools and sampling fields", () => {
    const parsed = parseAnthropicRequest(
      {
        model: "claude",
        system: [
          { type: "text", text: "Be concise" },
          { type: "text", text: "Be kind" },
        ],
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          { role: "system", content: "ignored role" },
        ],
        tools: [{ name: "search", input_schema: { type: "object" } }],
        max_tokens: 128,
        temperature: 0.2,
        stream: true,
      },
      "anthropic",
    );

    expect(parsed.system).toEqual([
      { type: "text", text: "Be concise" },
      { type: "text", text: "Be kind" },
    ]);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[1]?.role).toBe("assistant");
    expect(parsed.messages[2]?.role).toBe("user");
    expect(parsed.tools?.[0]).toEqual({
      name: "search",
      description: undefined,
      input_schema: { type: "object" },
    });
    expect(parsed.max_tokens).toBe(128);
    expect(parsed.temperature).toBe(0.2);
    expect(parsed.stream).toBe(true);
  });

  it("rejects OpenAI bodies without a messages array", () => {
    expect(() => parseOpenAIRequest({})).toThrow(new HttpError(400, "Invalid JSON body"));
    expect(() => parseOpenAIRequest({ messages: {} })).toThrow(
      new HttpError(400, "Invalid JSON body"),
    );
  });

  it("normalizes OpenAI messages, tool calls, tools and sampling fields", () => {
    const parsed = parseOpenAIRequest({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Be concise" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", function: { name: "search", arguments: '{"q":"cats"}' } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "Meow" },
        { role: "user", content: 42 },
      ],
      tools: [
        {
          type: "function",
          function: { name: "search", parameters: { type: "object" } },
        },
      ],
      max_tokens: 64,
      max_completion_tokens: 32,
      temperature: 0.7,
      stream: true,
    });

    expect(parsed.model).toBe("gpt-4o");
    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: "Be concise",
      tool_calls: undefined,
      tool_call_id: undefined,
    });
    expect(parsed.messages[1]?.tool_calls?.[0]?.function?.arguments).toBe('{"q":"cats"}');
    expect(parsed.messages[2]?.tool_call_id).toBe("call-1");
    expect(parsed.messages[3]?.content).toBeNull();
    expect(parsed.tools?.[0]?.function?.parameters).toEqual({ type: "object" });
    expect(parsed.max_tokens).toBe(64);
    expect(parsed.max_completion_tokens).toBe(32);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.stream).toBe(true);
  });

  it("ignores malformed array entries instead of throwing", () => {
    const parsed = parseOpenAIRequest({
      messages: [null, 42, { role: "user", content: "ok" }, "bad"],
      tools: [null, { function: { name: "noop" } }],
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.content).toBe("ok");
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools?.[0]?.function?.name).toBe("noop");
  });
});
