import assert from "node:assert/strict";
import test from "node:test";

const { finalObject, inputTransformationReports, parseEvents } = await import(new URL("../ui/events.js", import.meta.url).href);
const { INPUT_TRANSFORMATION_LABEL } = await import(new URL("../ui/labels.js", import.meta.url).href);

const reasoning = { id: "rs_synthetic", type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }] };
const message = { id: "msg_synthetic", type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] };
const done = (output_index: number, item: unknown) => ({ type: "response.output_item.done", output_index, item });
const stream = (data: unknown[]) => ({
  body: { text: data.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") },
  events: data.map((value, index) => ({ t: index, data: JSON.stringify(value) })),
});

for (const output of [undefined, []]) {
  test(`Lite terminal ${output ? "empty" : "absent"} output keeps completed items and terminal metadata`, () => {
    const terminal = { id: "resp_synthetic", status: "completed", output, end_turn: false, usage: { total_tokens: 42 } };
    const resp = stream([
      { type: "response.created", response: { id: "resp_synthetic", status: "in_progress" } },
      done(1, message), done(0, reasoning), done(1, message),
      { type: "response.completed", response: terminal },
    ]);
    const before = structuredClone(resp);
    const result = finalObject(resp);
    assert.deepEqual(result.value, { ...terminal, output: [reasoning, message] });
    assert.match(result.note, /output_item.done/);
    assert.deepEqual(resp, before);
    assert.deepEqual(parseEvents(resp).at(-1).json.response, JSON.parse(JSON.stringify(terminal)));
  });
}

test("a full terminal response remains authoritative without duplicating streamed items", () => {
  const terminal = { status: "completed", output: [{ ...message, phase: "final_answer" }], extra_metadata: "kept" };
  const resp = stream([done(0, message), { type: "response.completed", response: terminal }]);
  assert.deepEqual(finalObject(resp).value, terminal);
  assert.equal(finalObject(resp).value, parseEvents(resp).at(-1).json.response);
});

test("an interrupted stream retains completed items in output order and its errors", () => {
  const error = { type: "error", code: "synthetic_error", message: "Interrupted" };
  const resp = stream([
    { type: "response.created", response: { id: "resp_synthetic", status: "in_progress" } },
    done(1, message), done(0, reasoning), done(1, message), error,
  ]);
  const before = structuredClone(resp);
  assert.deepEqual(finalObject(resp).value, {
    id: "resp_synthetic", status: "in_progress", output: [reasoning, message], errors: [error],
  });
  assert.match(finalObject(resp).note, /未完成响应快照：没有收到终止事件/);
  assert.deepEqual(resp, before);
});

test("failed and incomplete terminals retain their diagnostics alongside completed items", () => {
  for (const status of ["failed", "incomplete"]) {
    const terminal = { status, error: { code: "synthetic_error" }, incomplete_details: { reason: "test" } };
    const resp = stream([done(0, message), { type: `response.${status}`, response: terminal }]);
    assert.deepEqual(finalObject(resp).value, { ...terminal, output: [message] });
  }
});

test("a terminal with no output items remains unchanged", () => {
  const terminal = { status: "failed", error: { code: "synthetic_error" } };
  assert.deepEqual(finalObject(stream([{ type: "response.failed", response: terminal }])).value, terminal);
});

const dropped = { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch", diagnostic_id: "synthetic" };
const allowed = { type: "thinking_mismatch_allowed", path: "messages.3.content.0", reason: "prefix_binding_mismatch" };

test("server input transformation reports preserve SSE sources, updated reports and unknown fields", () => {
  const future = { type: "future_transformation", path: "messages.4", extra: { synthetic: true } };
  const resp = stream([
    { type: "message_start", message: { id: "msg_synthetic", input_transformations: [dropped] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, input_transformations: [dropped, allowed, future] },
    { type: "message_stop" },
  ]);
  const before = structuredClone(resp);
  assert.deepEqual(inputTransformationReports(resp), [
    { event: 0, pointer: "/message/input_transformations", value: [dropped] },
    { event: 3, pointer: "/input_transformations", value: [dropped, allowed, future] },
  ]);
  assert.deepEqual(finalObject(resp).value.input_transformations, [dropped, allowed, future]);
  assert.deepEqual(finalObject(resp).value.content, [{ type: "text", text: "OK" }]);
  assert.deepEqual(resp, before);
  assert.equal(INPUT_TRANSFORMATION_LABEL[dropped.type], "已丢弃 thinking");
  assert.equal(INPUT_TRANSFORMATION_LABEL[allowed.type], "允许失配，保留 thinking");
});

test("message_delta nested transformation reports remain visible", () => {
  const resp = stream([
    { type: "message_start", message: { id: "msg_synthetic" } },
    { type: "message_delta", delta: { stop_reason: "end_turn", input_transformations: [dropped] } },
  ]);
  assert.deepEqual(inputTransformationReports(resp), [
    { event: 1, pointer: "/delta/input_transformations", value: [dropped] },
  ]);
  assert.deepEqual(finalObject(resp).value.input_transformations, [dropped]);
});

test("JSON input transformation reports distinguish absent, empty and unknown values", () => {
  for (const value of [[dropped, allowed], [], null, { future_format: true }]) {
    const resp = { body: { text: JSON.stringify({ type: "message", input_transformations: value }) } };
    assert.deepEqual(inputTransformationReports(resp), [{ event: null, pointer: "/input_transformations", value }]);
    assert.deepEqual(finalObject(resp).value.input_transformations, value);
  }
  assert.deepEqual(inputTransformationReports({ body: { text: '{"type":"message"}' } }), []);
  assert.deepEqual(inputTransformationReports({ body: { text: "invalid JSON" } }), []);
  assert.deepEqual(inputTransformationReports(null), []);
});

test("reports stay attached to each upstream call, including a failed auxiliary stream", () => {
  const calls = [
    { label: "handoff", response: stream([
      { type: "message_start", message: { input_transformations: [dropped] } },
      { type: "error", error: { type: "overloaded_error", message: "Synthetic error" } },
    ]) },
    { label: "main", response: stream([{ type: "message_start", message: { input_transformations: [] } }]) },
    { label: "summary", response: { body: { text: JSON.stringify({ type: "message", input_transformations: [allowed] }) } } },
  ];
  assert.deepEqual(calls.map(call => ({ label: call.label, reports: inputTransformationReports(call.response) })), [
    { label: "handoff", reports: [{ event: 0, pointer: "/message/input_transformations", value: [dropped] }] },
    { label: "main", reports: [{ event: 0, pointer: "/message/input_transformations", value: [] }] },
    { label: "summary", reports: [{ event: null, pointer: "/input_transformations", value: [allowed] }] },
  ]);
});
