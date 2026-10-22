import assert from "node:assert/strict";
import test from "node:test";
import { sseEvents } from "../src/inspect/view.ts";

const { responseLatency } = await import(new URL("../ui/latency.js", import.meta.url).href);
const stream = (events: [number, unknown][]) => ({ events: events.map(([t, data]) => ({ t, data: JSON.stringify(data) })) });
const text = (value: string) => ({ type: "message", content: [{ type: "output_text", text: value }] });

test("Responses content latency excludes headers, creation, empty deltas and keepalive", () => {
  const response = stream([
    [2, { type: "response.created", response: { output: [] } }],
    [3, { type: "keepalive" }],
    [4, { type: "response.output_item.added", item: { type: "reasoning", summary: [] } }],
    [5, { type: "response.output_text.delta", delta: "" }],
    [12, { type: "response.reasoning_summary_text.delta", delta: "Plan" }],
    [25, { type: "response.output_text.delta", delta: "Answer" }],
    [30, { type: "response.output_item.added", item: { type: "function_call", name: "exec", arguments: "" } }],
  ]);
  assert.deepEqual(responseLatency(response, 2), { content_ms: 10, text_ms: 23, reasoning_ms: 10, tool_ms: 28 });
});

test("Messages and Chat streams distinguish reasoning, text and tool delivery", () => {
  const messages = stream([
    [10, { type: "message_start", message: { content: [] } }],
    [20, { type: "content_block_start", content_block: { type: "thinking", thinking: "" } }],
    [30, { type: "content_block_delta", delta: { type: "signature_delta", signature: "synthetic" } }],
    [40, { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Plan" } }],
    [50, { type: "content_block_start", content_block: { type: "text", text: "" } }],
    [60, { type: "content_block_delta", delta: { type: "text_delta", text: "Answer" } }],
    [70, { type: "content_block_start", content_block: { type: "tool_use", name: "exec", input: {} } }],
  ]);
  const chat = stream([
    [10, { choices: [{ delta: { role: "assistant", content: "" } }] }],
    [40, { choices: [{ delta: { reasoning_content: "Plan" } }] }],
    [60, { choices: [{ delta: { content: "Answer" } }] }],
    [70, { choices: [{ delta: { tool_calls: [{ function: { name: "exec" } }] } }] }],
  ]);
  for (const response of [messages, chat]) {
    assert.deepEqual(responseLatency(response, 10), { content_ms: 30, text_ms: 50, reasoning_ms: 30, tool_ms: 60 });
  }
});

test("only terminal output and tool argument deltas are still meaningful content", () => {
  assert.deepEqual(responseLatency(stream([[100, {
    type: "response.completed", response: { output: [text("Answer")] },
  }]]), 0), { content_ms: 100, text_ms: 100, reasoning_ms: null, tool_ms: null });
  assert.deepEqual(responseLatency(stream([[10, {
    type: "response.custom_tool_call_input.delta", delta: "console.log(42)",
  }]]), 0), { content_ms: 10, text_ms: null, reasoning_ms: null, tool_ms: 10 });
});

test("downstream metrics ignore opaque reasoning and native checkpoints", () => {
  const response = stream([
    [20, { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "synthetic", summary: [] } }],
    [30, { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "synthetic" } }],
    [40, { type: "response.output_text.delta", delta: "Answer" }],
  ]);
  assert.equal(responseLatency(response, 0).reasoning_ms, 20);
  assert.deepEqual(responseLatency(response, 0, true), { content_ms: 40, text_ms: 40, reasoning_ms: null, tool_ms: null });
});

test("separate auxiliary calls use their own start, client delivery includes handoff time", () => {
  const handoff = stream([[60, { type: "response.output_text.delta", delta: "Summary" }]]);
  const main = stream([[140, { type: "response.output_text.delta", delta: "Answer" }]]);
  const client = stream([[150, { type: "response.output_text.delta", delta: "Answer" }]]);
  assert.equal(responseLatency(handoff, 10).content_ms, 50);
  assert.equal(responseLatency(main, 100).content_ms, 40);
  assert.equal(responseLatency(client, 0, true).content_ms, 150);
});

test("metrics use the chunk that completes an SSE event and do not flush an active tail", () => {
  const data = { type: "response.output_text.delta", delta: "Answer" };
  const encoded = `data: ${JSON.stringify(data)}\r\n\r\n`;
  for (let split = 1; split < encoded.length; split++) {
    const first = { t: 10, text: encoded.slice(0, split) };
    const second = { t: 20, text: encoded.slice(split) };
    assert.equal(responseLatency({ events: sseEvents([first], false) }, 0).content_ms, null);
    assert.equal(responseLatency({ events: sseEvents([first, second], false) }, 0).content_ms, 20);
  }
});

test("absent, untimed, truncated and JSON captures do not invent first-token timings", () => {
  assert.equal(responseLatency(null, 0), null);
  assert.equal(responseLatency({ body: { text: JSON.stringify({ output: [text("Answer")] }) } }, 0), null);
  assert.equal(responseLatency({ events: [{ data: JSON.stringify({ type: "response.output_text.delta", delta: "Answer" }) }] }, 0).content_ms, null);
  assert.equal(responseLatency({ events: [{ t: 10, data: '{"type":"response.output_text.delta","delta":"partial' }] }, 0).content_ms, null);
  assert.equal(responseLatency(stream([[5, { type: "response.output_text.delta", delta: "Answer" }]]), 10).content_ms, null);
  assert.equal(responseLatency(stream([[5, { type: "response.output_text.delta", delta: "Answer" }]])), null);
});
