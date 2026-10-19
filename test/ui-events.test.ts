import assert from "node:assert/strict";
import test from "node:test";

const { finalObject, parseEvents } = await import(new URL("../ui/events.js", import.meta.url).href);

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
  assert.deepEqual(finalObject(resp).value, {
    id: "resp_synthetic", status: "in_progress", output: [reasoning, message], errors: [error],
  });
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
