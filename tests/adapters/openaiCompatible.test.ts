import { describe, expect, it } from "bun:test";
import {
  fitsOpenAICompatibleContext,
  safeJsonParse,
  sanitizeOpenAICompatibleSchema,
} from "../../src/adapters/openaiCompatible";

describe("OpenAI Compatible Helpers", () => {
  it("safeJsonParse parses valid json and returns empty object on error", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse("invalid")).toEqual({});
  });

  it("fitsOpenAICompatibleContext validates context limits", () => {
    expect(fitsOpenAICompatibleContext(1000, 2000)).toBe(true);
    expect(fitsOpenAICompatibleContext(3000, 2000)).toBe(false);
  });

  it("sanitizeOpenAICompatibleSchema removes unsupported schema keys", () => {
    const input = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
      },
    };
    const cleaned = sanitizeOpenAICompatibleSchema(input) as any;
    expect(cleaned.type).toBe("object");
    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    expect(cleaned.properties.name.type).toBe("string");
  });
});
