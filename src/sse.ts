// Server-sent events: a small parser for upstream streams and a formatter for
// the stream we send to codeks.

export interface SseEvent {
  event: string | undefined;
  data: string;
}

/** Parses an SSE byte stream. Comment lines (keepalives) are skipped. */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  let hasData = false;

  function* takeLines(final: boolean): Generator<SseEvent> {
    let start = 0;
    for (;;) {
      let end = -1;
      let next = -1;
      for (let i = start; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i);
        if (c === 10) {
          end = i;
          next = i + 1;
          break;
        }
        if (c === 13) {
          if (i + 1 < buffer.length) {
            end = i;
            next = buffer.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
            break;
          }
          if (final) {
            end = i;
            next = i + 1;
          }
          break;
        }
      }
      if (end < 0) break;
      const line = buffer.slice(start, end);
      start = next;
      if (line === "") {
        if (hasData) yield { event, data: data.join("\n") };
        event = undefined;
        data = [];
        hasData = false;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") {
        data.push(value);
        hasData = true;
      } else if (field === "event") {
        event = value;
      }
    }
    buffer = buffer.slice(start);
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* takeLines(false);
  }
  buffer += decoder.decode();
  buffer += "\n\n";
  yield* takeLines(true);
}

/** Parses each SSE data payload as JSON. "[DONE]" ends the stream. */
export async function* parseJsonSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ event: string | undefined; json: any }> {
  for await (const ev of parseSse(body)) {
    const text = ev.data.trim();
    if (text === "") continue;
    if (text === "[DONE]") return;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`upstream sent an SSE event that is not JSON: ${text.slice(0, 200)}`);
    }
    yield { event: ev.event, json };
  }
}

export function formatSse(data: unknown, event?: string): string {
  const head = event ? `event: ${event}\n` : "";
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}
