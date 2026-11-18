/**
 * Shared Server-Sent Events (SSE) plumbing.
 *
 * Every upstream provider (OpenAI-compatible, Gemini, Cohere) and every
 * downstream format (Anthropic, OpenAI) uses the same framing:
 *
 *   event: <name>\n
 *   data: <payload>\n
 *   \n
 *
 * Some streams omit the `event:` line; those events are still returned with an
 * empty `event` field so callers can decide what to do with them.
 */

export interface SSEEvent {
  event: string;
  data: string;
}

const encoder = new TextEncoder();

/** Encode a single named SSE event. */
export function encodeSSE(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseFrame(raw: string): SSEEvent | undefined {
  if (!raw.trim()) return undefined;

  let event = "";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice(6).trim();
    } else if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

/**
 * Split a decoded buffer into complete SSE events plus the unfinished tail.
 * Accepts both `\n\n` and `\r\n\r\n` frame separators.
 */
export function parseSSEFrames(buffer: string): { events: SSEEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: SSEEvent[] = [];

  for (const frame of frames) {
    const parsed = parseFrame(frame);
    if (parsed) events.push(parsed);
  }

  return { events, rest };
}

/** Stream decoded SSE events from a response body. */
export async function* iterateSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSSEFrames(buffer);
      buffer = rest;
      for (const event of events) yield event;
    }

    buffer += decoder.decode();
    const parsed = parseFrame(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}
