import assert from "node:assert/strict";
import test from "node:test";

const { responseClass, responseFailure, exchangeClass, upstreamCalls } = await import(new URL("../ui/status.js", import.meta.url).href);
const { matches, FILTER_CHIPS } = await import(new URL("../ui/list.js", import.meta.url).href);
const { OUTCOME_LABEL, annIndex } = await import(new URL("../ui/labels.js", import.meta.url).href);

const stream = (...events: unknown[]) => ({
  status: 200, end: "cancelled", error: "Synthetic disconnect",
  events: events.map(data => ({ data: JSON.stringify(data) })),
});

test("client disconnect is amber without claiming success or inferring a cancellation reason", () => {
  for (const response of [stream(), { ...stream(), failure: null }]) {
    assert.equal(responseClass(response), "warn");
    assert.equal(responseFailure(response), null);
    assert.equal(exchangeClass({ outcome: "aborted", status: 200, client: { response } }), "warn");
  }
  assert.equal(OUTCOME_LABEL.aborted, "客户端断开");
});

test("an explicit failure stays red when the connection later closes", () => {
  const failure = { kind: "protocol", message: "Synthetic provider failure" };
  for (const response of [
    { ...stream(), failure },
    stream({ type: "response.failed", response: { error: { message: failure.message } } }),
    stream({ type: "error", error: { message: failure.message } }),
    { ...stream(), status: 503 },
    { ...stream(), end: "error" },
  ]) {
    assert.equal(responseClass(response), "bad");
    assert.equal(exchangeClass({ outcome: "aborted", status: response.status, client: { response } }), "bad");
  }
  assert.equal(responseClass(null, "Synthetic connection failure"), "bad");
  assert.equal(responseClass({ status: 200, end: "complete", body: { text: '{"error":{"message":"Synthetic JSON failure"}}' } }), "bad");
});

test("current invalid calls need attention without changing successful response outcome", () => {
  const completed = { outcome: "completed", status: 200, tool_error_count: 0 };
  const current = { ...completed, tool_error_count: 1 };
  assert.equal(exchangeClass(current), "ok");
  assert.equal(matches(current, [], { errors: true }), true);
  assert.equal(matches(current, ["无效工具调用"], {}), true);
  assert.equal(matches(completed, [], { errors: true }), false);
  assert.equal(FILTER_CHIPS.find(([key]: string[]) => key === "errors")[1], "需关注");
  const historical = { ...completed, tool_diagnostics: [{ target: "client.request", name: "synthetic_typo", message: "Unknown tool" }] };
  assert.equal(matches(historical, [], { errors: true }), false);
  assert.equal(exchangeClass(historical), "ok");
});

test("attention includes incomplete responses and auxiliary failures", () => {
  for (const extra of [
    { outcome: "aborted" },
    { outcome: "incomplete" },
    { upstream_calls: [{ status: 200, end: "cancelled" }] },
    { upstream_calls: [{ status: 200, end: "complete", failure: { kind: "protocol", message: "Failed" } }] },
    { upstream: [{ response: stream({ type: "response.failed" }) }] },
    { upstream: [{ error: "Synthetic fetch error", response: null }] },
  ]) assert.equal(matches({ outcome: "completed", status: 200, ...extra }, [], { errors: true }), true);
});

test("tool diagnostics use item and event locations without changing captured content", () => {
  const history = { target: "client.request", pointer: "/input/3", call_id: "synthetic_call", name: "synthetic_typo", message: "Unknown tool" };
  const current = { ...history, target: "client.response", pointer: "/item", event: 4 };
  const list = [history, current];
  const before = structuredClone(list);
  assert.deepEqual(annIndex(list, "client.request").byPointer.get("/input/3"), [history]);
  assert.deepEqual(annIndex(list, "client.response").byEvent.get(4), [current]);
  assert.equal(annIndex(list, "client.request").byEvent.size, 0);
  assert.deepEqual(list, before);
});

test("old imports use full upstream failure evidence instead of lossy call summaries", () => {
  const response = { ...stream({ type: "error", error: { message: "Synthetic provider failure" } }), end: "complete" };
  const exchange = {
    outcome: "completed", status: 200,
    upstream_calls: [{ label: "main", status: 200, end: "complete" }],
    upstream: [{ label: "main", response }],
  };
  const before = structuredClone(exchange);
  assert.equal(responseClass(response), "bad");
  assert.equal(responseClass(upstreamCalls(exchange)[0]), "bad");
  assert.equal(matches(exchange, [], { errors: true }), true);
  assert.deepEqual(exchange, before);
});
