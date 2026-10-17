import assert from "node:assert/strict";
import test from "node:test";
import { formatSse, parseJsonSse, parseSse } from "../src/sse.ts";

async function* chunks(text: string, size = 1): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

test("SSE parsing handles byte-split UTF-8, split CRLF, comments and multiline data", async () => {
  const input = ': keepalive\r\nevent: message\r\ndata: {"text":"你好"}\r\ndata: second line\r\n\r\n';
  assert.deepEqual(await collect(parseSse(chunks(input))), [{ event: "message", data: '{"text":"你好"}\nsecond line' }]);
});

test("SSE recognizes CR and LF delimiters, empty data and final events without a separator", async () => {
  const input = 'data: first\r\rdata:\n\nevent: last\ndata: final';
  assert.deepEqual(await collect(parseSse(chunks(input, 4))), [
    { event: undefined, data: "first" }, { event: undefined, data: "" }, { event: "last", data: "final" },
  ]);
});

test("JSON SSE stops at DONE and reports malformed upstream data", async () => {
  assert.deepEqual(await collect(parseJsonSse(chunks('data: {"delta":1}\n\ndata: [DONE]\n\ndata: invalid\n\n'))), [
    { event: undefined, json: { delta: 1 } },
  ]);
  await assert.rejects(collect(parseJsonSse(chunks("data: invalid\n\n"))), /not JSON/);
});

test("formatted events preserve newlines inside JSON strings", async () => {
  const json = { text: "first\nsecond" };
  assert.deepEqual(await collect(parseJsonSse(chunks(formatSse(json, "delta")))), [{ event: "delta", json }]);
});
