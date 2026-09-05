import { describe, expect, it } from "bun:test";
import {
  anthropicResponseToOpenAI,
  anthropicToolsToOpenAI,
  openAIRequestToNormalized,
  openAIResponseToAnthropic,
  readProviderError,
} from "../src/adapters/openaiCompatible";
import { AnthropicSSEWriter } from "../src/streaming/anthropicSSE";
import { anthropicStreamToOpenAI } from "../src/streaming/openaiSSE";
import type { AnthropicResponse } from "../src/types";

describe("OpenAI compatibility and streaming", () => {
  it("summarizes HTML block pages from upstream providers", async () => {
    const response = new Response(
      '<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head><body><span data-translate="unable_to_access">You are unable to access</span> api.cloudflare.com</body></html>',
      {
        status: 403,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      },
    );

    await expect(readProviderError(response, "Cloudflare AI", "@cf/example/model")).resolves.toBe(
      'Cloudflare AI request was blocked upstream for model "@cf/example/model" (HTTP 403): Attention Required! | Cloudflare; unable to access api.cloudflare.com',
    );
  });

  it("normalizes OpenAI request payload", () => {
    const openAIReq = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Hello!" },
      ],
      temperature: 0.5,
      stream: true,
    };

    const normalized = openAIRequestToNormalized(openAIReq);
    expect(normalized.systemPrompt).toBe("You are an assistant.");
    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0].content).toBe("Hello!");
    expect(normalized.stream).toBe(true);
    expect(normalized.temperature).toBe(0.5);
  });

  it("converts Anthropic response to OpenAI completion JSON", () => {
    const anthropicResp: AnthropicResponse = {
      id: "msg_abc123",
      type: "message",
      role: "assistant",
      model: "llama-3.3-70b",
      content: [{ type: "text", text: "Hello from model!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 8 },
    };

    const openAIJson = anthropicResponseToOpenAI(anthropicResp, "model-router-auto");
    expect(openAIJson.id).toBe("chatcmpl-msg_abc123");
    expect(openAIJson.object).toBe("chat.completion");
    expect(openAIJson.choices[0].message.content).toBe("Hello from model!");
    expect(openAIJson.choices[0].finish_reason).toBe("stop");
    expect(openAIJson.usage.total_tokens).toBe(20);
  });

  it("keeps Groq reasoning-only responses usable", () => {
    const groqResponse = {
      id: "chatcmpl-groq-reasoning",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            reasoning: "The user says 'ping'. This is a short acknowledgment response.",
          },
          finish_reason: "length",
        },
      ],
      usage: {
        prompt_tokens: 72,
        completion_tokens: 16,
      },
    };

    const result = openAIResponseToAnthropic(groqResponse, "openai/gpt-oss-120b");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "The user says 'ping'. This is a short acknowledgment response.",
    });
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("sanitizes unsupported tool schema features before OpenAI-compatible calls", () => {
    const tools = [
      {
        name: "Artifact",
        description: "Artifact tool",
        input_schema: {
          type: "object",
          properties: {
            after: {
              type: "string",
              pattern: "^[A-Za-z0-9_=-]{1,4096}$",
            },
          },
          required: ["after"],
        },
      },
    ];

    const openAITools = anthropicToolsToOpenAI(tools as any);
    expect(openAITools[0].function.parameters).toEqual({
      type: "object",
      properties: {
        after: {
          type: "string",
        },
      },
      required: ["after"],
    });
  });

  it("converts Anthropic SSE stream to OpenAI SSE chunks", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const writer = new AnthropicSSEWriter(controller);
        writer.start("codestral-latest", "msg_test_sse", 10);
        writer.startText();
        writer.textDelta("Hi");
        writer.textDelta(" there");
        writer.stopBlock();
        writer.end("end_turn", 10, 5);
      },
    });

    const openAIStream = anthropicStreamToOpenAI(source, "model-router-auto");
    const reader = openAIStream.getReader();
    const decoder = new TextDecoder();
    let fullOutput = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullOutput += decoder.decode(value);
    }

    expect(fullOutput).toContain('data: {"id":"chatcmpl-msg_test_sse"');
    expect(fullOutput).toContain('"delta":{"content":"Hi"}');
    expect(fullOutput).toContain('"delta":{"content":" there"}');
    expect(fullOutput).toContain("data: [DONE]");
  });
});
