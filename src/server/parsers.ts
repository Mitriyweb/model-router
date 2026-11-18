/**
 * Boundary parsers for request bodies.
 *
 * `readJsonBody` deliberately returns `unknown`; these functions are the only
 * place that decides what a valid Anthropic or OpenAI request looks like and
 * produces a 400-shaped `HttpError` otherwise. They do not depend on any
 * validation library and preserve the shapes consumed by the adapters.
 */
import type { OpenAIMessage, OpenAIRequest, OpenAITool } from "../adapters/openaiCompatible";
import type { AnthropicMessage, AnthropicRequest, ContentBlock, ToolDefinition } from "../types";
import type { ApiFormat } from "./http";
import { HttpError } from "./http";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseTools(value: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((tool) => ({
    name: asString(tool.name) ?? "",
    description: asString(tool.description),
    input_schema: isRecord(tool.input_schema)
      ? tool.input_schema
      : { type: "object", properties: {} },
  }));
}

function parseSystem(value: unknown): AnthropicRequest["system"] {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((block) => ({ type: "text" as const, text: asString(block.text) ?? "" }));
  }
  return undefined;
}

function parseAnthropicMessages(value: unknown): AnthropicMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((message) => {
    let content: AnthropicMessage["content"] = "";
    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      // Content blocks are interpreted by the adapters; the boundary only
      // establishes that this field is an array.
      content = message.content as ContentBlock[];
    }
    return {
      role: message.role === "assistant" ? "assistant" : "user",
      content,
    };
  });
}

export function parseAnthropicRequest(value: unknown, format: ApiFormat): AnthropicRequest {
  if (!isRecord(value)) {
    const message = format === "openai" ? "Invalid JSON body" : "invalid JSON body";
    throw new HttpError(400, message);
  }

  return {
    model: asString(value.model),
    messages: parseAnthropicMessages(value.messages),
    system: parseSystem(value.system),
    max_tokens: asFiniteNumber(value.max_tokens),
    temperature: asFiniteNumber(value.temperature),
    stream: asBoolean(value.stream),
    tools: parseTools(value.tools),
  };
}

function parseOpenAITools(value: unknown): OpenAITool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((tool) => ({
    name: asString(tool.name),
    description: asString(tool.description),
    parameters: isRecord(tool.parameters) ? tool.parameters : undefined,
    function: isRecord(tool.function)
      ? {
          name: asString(tool.function.name),
          description: asString(tool.function.description),
          parameters: isRecord(tool.function.parameters) ? tool.function.parameters : undefined,
        }
      : undefined,
  }));
}

function parseOpenAIMessages(value: unknown[]): OpenAIMessage[] {
  return value.filter(isRecord).map((message) => ({
    role: asString(message.role),
    content: asString(message.content) ?? null,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.filter(isRecord).map((call) => ({
          id: asString(call.id),
          function: isRecord(call.function)
            ? {
                name: asString(call.function.name),
                arguments: asString(call.function.arguments),
              }
            : undefined,
        }))
      : undefined,
    tool_call_id: asString(message.tool_call_id),
  }));
}

/**
 * Parse an OpenAI chat-completions body. `messages` must be an array — the
 * same requirement the handler enforced before this parser existed.
 */
export function parseOpenAIRequest(value: unknown): OpenAIRequest {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new HttpError(400, "Invalid JSON body");
  }

  return {
    model: asString(value.model),
    messages: parseOpenAIMessages(value.messages),
    tools: parseOpenAITools(value.tools),
    max_tokens: asFiniteNumber(value.max_tokens),
    max_completion_tokens: asFiniteNumber(value.max_completion_tokens),
    temperature: asFiniteNumber(value.temperature),
    stream: asBoolean(value.stream),
  };
}
