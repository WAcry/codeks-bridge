import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { Call, Exchange, Inspector, headerMap } from "../src/inspect/capture.ts";
import { detail, summary } from "../src/inspect/view.ts";
import { prepareToolCall, toolCallDiagnostic, writeToolCall } from "../src/tool-calls.ts";
import { buildToolSet } from "../src/tools.ts";
import { ResponseWriter } from "../src/writer.ts";

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const completed = (output: unknown[] = []) => ({ type: "response.completed", response: { status: "completed", output, usage } });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function capture(input: Record<string, any>[] = [], contentType = "text/event-stream", status = 200) {
  const inspector = new Inspector({ upstreams: {}, models: {} });
  const request = new IncomingMessage(new Socket());
  request.method = "POST";
  request.url = "/v1/responses";
  const response = new ServerResponse(request);
  const exchange = new Exchange(inspector, 1, request, response);
  inspector.exchanges.set(exchange.id, exchange);
  const body = { model: "synthetic", stream: contentType === "text/event-stream", input };
  exchange.received(JSON.stringify(body));
  exchange.parsed(body);
  exchange.response.head(status, undefined, { "content-type": contentType });
  return {
    exchange,
    cancel: () => response.emit("close"),
    complete: () => {
      exchange.response.finish("complete");
      response.emit("close");
    },
  };
}

function upstream(exchange: Exchange, status = 200, contentType = "text/event-stream") {
  const call = new Call(exchange, "main", "https://example.com/responses", {}, "{}");
  exchange.calls.push(call);
  call.received(new Response(null, { status, headers: { "content-type": contentType } }));
  return call;
}

test("upstream capture redacts Gemini credentials without rewriting safe routing fields or bodies", () => {
  const { exchange } = capture();
  const url = "https://example.com/models/synthetic:streamGenerateContent?alt=sse&key=synthetic-secret&key=second-secret&trace=one%20two";
  const headers = headerMap(new Headers({ "x-goog-api-key": "synthetic-secret", "x-request-id": "synthetic-request" }));
  const call = new Call(exchange, "main", url, headers, '{"text":"body stays unchanged"}');
  const captured = new URL(call.url);
  assert.equal(captured.pathname, "/models/synthetic:streamGenerateContent");
  assert.equal(captured.searchParams.get("alt"), "sse");
  assert.equal(captured.searchParams.get("trace"), "one two");
  assert.equal(captured.searchParams.getAll("key").length, 2);
  for (const value of captured.searchParams.getAll("key")) assert.match(value, /^\[redacted:/);
  assert(!call.url.includes("synthetic-secret"));
  assert(!call.url.includes("second-secret"));
  assert.match(call.headers["x-goog-api-key"], /^\[redacted:/);
  assert.equal(call.headers["x-request-id"], "synthetic-request");
  assert.equal(call.text, '{"text":"body stays unchanged"}');
  const safe = "https://example.com/models/synthetic:streamGenerateContent?alt=sse&trace=one%20two";
  assert.equal(new Call(exchange, "main", safe, {}, "{}").url, safe);
});

const tools = buildToolSet([{ type: "namespace", name: "clock", tools: [
  { type: "function", name: "sleep", parameters: { type: "object", properties: {} } },
] }]);

function toolEvents(name: string): any[] {
  const events: any[] = [];
  const writer = new ResponseWriter({ write: chunk => events.push(JSON.parse(chunk.slice(6))) }, { model: "synthetic" });
  writer.start();
  writeToolCall(writer, prepareToolCall(tools, "call_synthetic", name, { duration_ms: 1 }));
  writer.complete(usage, false);
  return events;
}

test("a client disconnect preserves its partial response and has no invented failure cause", () => {
  const f = capture();
  const partial = event({ type: "response.created", response: { id: "resp_synthetic", status: "in_progress" } });
  f.exchange.response.push(partial);
  assert.equal(detail(f.exchange).client.response?.failure, null);
  f.cancel();
  const view = detail(f.exchange);
  assert.equal(view.outcome, "aborted");
  assert.equal(view.error, "Client disconnected");
  assert.equal(view.client.response?.end, "cancelled");
  assert.equal(view.client.response?.error, "Client disconnected");
  assert.equal(view.client.response?.failure, null);
  assert.equal(view.client.response?.body.text, partial);
  assert.equal(view.client.response?.events?.length, 1);
});

test("an explicit failure stays a failure when the client later disconnects", () => {
  const f = capture();
  assert.equal(detail(f.exchange).client.response?.failure, null, "An active snapshot cannot cache a future absence");
  const failed = event({ type: "response.failed", response: { error: { message: "Synthetic overload" }, usage } });
  f.exchange.response.push(failed);
  f.cancel();
  const view = detail(f.exchange);
  assert.equal(view.outcome, "failed");
  assert.equal(view.error, "Synthetic overload");
  assert.deepEqual(view.usage, usage);
  assert.deepEqual(view.client.response?.failure, { kind: "protocol", message: "Synthetic overload" });
  assert.equal(view.client.response?.end, "cancelled");
  assert.equal(view.client.response?.error, "Client disconnected");
  assert.equal(view.client.response?.body.text, failed);
});

test("HTTP failures and explicit error events retain their own failure identity", () => {
  for (const [status, contentType, body, kind] of [
    [400, "application/json", JSON.stringify({ error: { message: "Synthetic input error" } }), "http"],
    [200, "application/json", JSON.stringify({ error: { message: "Synthetic input error" } }), "protocol"],
    [200, "text/event-stream", event({ type: "error", error: { message: "Synthetic input error" } }), "protocol"],
  ] as const) {
    const f = capture([], contentType, status);
    f.exchange.response.push(body);
    f.cancel();
    const view = detail(f.exchange);
    assert.equal(view.outcome, "error");
    assert.deepEqual(view.client.response?.failure, { kind, message: "Synthetic input error" });
    assert.equal(view.client.response?.body.text, body);
  }
});

test("upstream failure evidence survives a later client cancellation", () => {
  for (const kind of ["http", "protocol", "transport"] as const) {
    const f = capture();
    const call = upstream(f.exchange, kind === "http" ? 503 : 200, kind === "http" ? "application/json" : "text/event-stream");
    if (kind === "transport") call.done("error", new Error("Synthetic stream failure"));
    else call.response!.push(kind === "http" ? JSON.stringify({ error: { message: "Synthetic stream failure" } })
      : event({ type: "error", error: { message: "Synthetic stream failure" } }));
    f.cancel();
    const view = detail(f.exchange);
    const failure = { kind, message: "Synthetic stream failure" };
    assert.deepEqual(view.upstream[0].response?.failure, failure);
    assert.deepEqual(view.upstream_calls[0].failure, failure);
    assert.equal(view.upstream[0].response?.end, kind === "transport" ? "error" : "cancelled");
  }
});

test("ordinary error words and incomplete SSE bytes are not explicit failures", () => {
  const f = capture();
  f.exchange.response.push(event({ type: "response.output_text.delta", delta: "An error was fixed." }));
  f.exchange.response.push(`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Not delivered" } } })}`);
  f.cancel();
  assert.equal(summary(f.exchange).outcome, "aborted");
  assert.equal(detail(f.exchange).client.response?.failure, null);
});

test("only committed output calls count, even when repeated in added, done, and completed events", () => {
  const f = capture();
  const events = toolEvents("clock__slep");
  const done = events.find(value => value.type === "response.output_item.done");
  const doneIndex = events.indexOf(done);
  assert.match(done.item.call_id, /^cxbt1_/);
  const text = events.concat(done).map(event).join("");
  // Split every carrier prefix across capture chunks, as TCP may do.
  for (let index = 0; index < text.length; index += 3) f.exchange.response.push(text.slice(index, index + 3));
  f.complete();
  const view = detail(f.exchange);
  assert.equal(view.outcome, "completed");
  assert.equal(view.tool_error_count, 1);
  assert.equal(view.tool_diagnostics.length, 1);
  assert.deepEqual(view.tool_diagnostics[0], {
    target: "client.response", pointer: "/item", event: doneIndex, call_id: done.item.call_id,
    name: "clock__slep", message: toolCallDiagnostic(done.item)!.message,
  });
  assert.match(view.tool_diagnostics[0].message, /clock__sleep/);
  assert.equal(view.client.response?.body.text, text);
});

test("an added tool call is not committed, and a corrected alias is not a tool error", () => {
  const uncommitted = capture();
  const events = toolEvents("clock__slep");
  const added = events.find(value => value.type === "response.output_item.added");
  uncommitted.exchange.response.push(event(added));
  uncommitted.cancel();
  assert.equal(summary(uncommitted.exchange).tool_error_count, 0);
  const valid = capture();
  const alias = toolEvents("sleep");
  assert.match(alias.find(value => value.type === "response.output_item.done").item.call_id, /^cxbt1_/);
  valid.exchange.response.push(alias.map(event).join(""));
  valid.complete();
  assert.equal(summary(valid.exchange).tool_error_count, 0);
  assert.deepEqual(detail(valid.exchange).tool_diagnostics, []);
});

test("historical diagnostics annotate call and result without tainting the next successful response", () => {
  const item = toolEvents("clock__slep").find(value => value.type === "response.output_item.done").item;
  const result = { type: "function_call_output", call_id: item.call_id, output: "unsupported call: synthetic dispatch" };
  const f = capture([item, result]);
  f.exchange.response.push(event(completed()));
  f.complete();
  const view = detail(f.exchange);
  assert.equal(view.outcome, "completed");
  assert.equal(view.tool_error_count, 0);
  assert.deepEqual(view.tool_diagnostics.map(note => [note.target, note.pointer]), [
    ["client.request", "/input/0"], ["client.request", "/input/1"],
  ]);
  assert.equal(JSON.parse(view.client.request.body.text).input[1].output, result.output);
});

test("JSON output diagnostics are deduplicated and invalid carriers or arbitrary text remain unclassified", () => {
  const item = toolEvents("clock__slep").find(value => value.type === "response.output_item.done").item;
  const f = capture([], "application/json");
  f.exchange.response.push(JSON.stringify({ object: "response", status: "completed", output: [item, item], usage }));
  f.complete();
  const view = detail(f.exchange);
  assert.equal(view.tool_error_count, 1);
  assert.equal(view.tool_diagnostics[0].pointer, "/output/0");
  assert.equal(view.tool_diagnostics[0].event, undefined);
  for (const call_id of ["cxbt1_invalid", "cxbt1_" + Buffer.from(JSON.stringify({ error: "Wrong shape" })).toString("base64url"), "ordinary"]) {
    assert.equal(toolCallDiagnostic({ type: "function_call_output", call_id, output: "unsupported call: codeks_bridge_tool_errorinvalid_call" }), undefined);
  }
});
