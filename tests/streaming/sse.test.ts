import { describe, expect, it } from "bun:test";
import { type SSEEvent, encodeSSE, iterateSSE, parseSSEFrames } from "../../src/streaming/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of iterateSSE(stream)) events.push(event);
  return events;
}

describe("SSE utilities", () => {
  it("parses complete frames and keeps the unfinished tail", () => {
    const { events, rest } = parseSSEFrames(
      'event: message_start\ndata: {"a":1}\n\nevent: message_stop\ndata: {"b"',
    );

    expect(events).toEqual([{ event: "message_start", data: '{"a":1}' }]);
    expect(rest).toBe('event: message_stop\ndata: {"b"');
  });

  it("accepts CRLF frame separators", () => {
    const { events, rest } = parseSSEFrames('event: ping\r\ndata: {"ok":true}\r\n\r\n');

    expect(events).toEqual([{ event: "ping", data: '{"ok":true}' }]);
    expect(rest).toBe("");
  });

  it("handles frames without an event name", () => {
    const { events } = parseSSEFrames('data: {"choices":[]}\n\n');

    expect(events).toEqual([{ event: "", data: '{"choices":[]}' }]);
  });

  it("joins multiple data lines per frame", () => {
    const { events } = parseSSEFrames("data: line one\ndata: line two\n\n");

    expect(events[0].data).toBe("line one\nline two");
  });

  it("iterates a stream split across arbitrary chunk boundaries", async () => {
    const events = await collect(
      streamOf([
        'event: message_start\ndata: {"id":"m',
        'sg_1"}\n\nevent: content_block_delta\ndata: {"delta":{"text":"hi"}}\n',
        "\n",
      ]),
    );

    expect(events).toEqual([
      { event: "message_start", data: '{"id":"msg_1"}' },
      { event: "content_block_delta", data: '{"delta":{"text":"hi"}}' },
    ]);
  });

  it("emits a final frame that has no trailing blank line", async () => {
    const events = await collect(streamOf(['data: {"last":true}']));

    expect(events).toEqual([{ event: "", data: '{"last":true}' }]);
  });

  it("encodes named events with JSON payloads", () => {
    const bytes = encodeSSE("message_stop", { type: "message_stop" });
    const text = new TextDecoder().decode(bytes);

    expect(text).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});
