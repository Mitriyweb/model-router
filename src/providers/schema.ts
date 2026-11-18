/**
 * JSON Schema sanitizer shared by every provider that rejects parts of the
 * Anthropic/JSON Schema dialect (OpenAI-compatible endpoints and Gemini).
 *
 * Unsupported keywords are dropped recursively; `required` entries that no
 * longer point at a real property are removed.
 */

const UNSUPPORTED_KEYS = new Set([
  "$schema",
  "$defs",
  "definitions",
  "additionalProperties",
  "propertyNames",
  "const",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "nullable",
  "title",
  "description",
  "format",
  "contentEncoding",
  "contentMediaType",
  "pattern",
  "anyOf",
  "allOf",
  "oneOf",
  "any_of",
  "all_of",
  "one_of",
  "not",
]);

export function sanitizeToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolSchema(item));
  }

  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};

    for (const [key, innerValue] of Object.entries(value as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYS.has(key)) continue;
      cleaned[key] = sanitizeToolSchema(innerValue);
    }

    if (cleaned.properties && typeof cleaned.properties === "object") {
      const properties = Object.fromEntries(
        Object.entries(cleaned.properties as Record<string, unknown>).map(([name, schema]) => [
          name,
          sanitizeToolSchema(schema),
        ]),
      );
      cleaned.properties = properties;

      if (Array.isArray(cleaned.required)) {
        const valid = new Set(Object.keys(properties));
        cleaned.required = cleaned.required.filter(
          (item) => typeof item === "string" && valid.has(item),
        );
      }
    }

    return cleaned;
  }

  return value;
}
