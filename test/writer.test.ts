import assert from "node:assert/strict";
import test from "node:test";
import { ResponseWriter } from "../src/writer.ts";

function fixture(showSummary = true) {
  const events: any[] = [];
  const writer = new ResponseWriter({ write(chunk) {
    events.push(JSON.parse(chunk.split("data: ")[1].trim()));
  } }, { model: "test-model", responseId: "resp_synthetic", showSummary });
  writer.start();
  return { writer, events };
}

function validateOrder(events: any[]) {
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  const added = new Map<string, number>();
  for (const event of events) {
    if (event.type === "response.output_item.added") added.set(event.item.id, event.output_index);
    if (event.item_id) assert.equal(added.get(event.item_id), event.output_index, event.type);
    if (event.type === "response.output_item.done") assert.equal(added.get(event.item.id), event.output_index);
  }
}

test("writer orders added/delta/done events and returns complete history and usage", () => {
  const { writer, events } = fixture();
  writer.reasoningDelta("Think ");
  writer.reasoningDelta("carefully.");
  writer.endReasoning("synthetic-carrier");
  writer.textDelta("Hello ");
  writer.textDelta("world.");
  writer.complete({ input_tokens: 100, cached_tokens: 80, output_tokens: 20, reasoning_tokens: 15 });
  validateOrder(events);
  const completed = events.at(-1).response;
  assert.equal(completed.id, "resp_synthetic");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output[0].encrypted_content, "synthetic-carrier");
  assert.equal(completed.output[1].content[0].text, "Hello world.");
  assert.equal(completed.output[1].phase, "final_answer");
  assert.deepEqual(completed.usage, {
    input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 15 }, total_tokens: 120,
  });
});

test("tool calls wait for successful completion and preceding text is commentary", () => {
  const { writer, events } = fixture();
  writer.textDelta("I will inspect the file.");
  writer.addFunctionCall({ call_id: "call_read", namespace: "files", name: "read", arguments: '{"path":"notes.txt"}' });
  writer.addCustomToolCall({ call_id: "call_edit", name: "edit", input: "raw\npatch" });
  assert.equal(events.some((event) => event.item?.type === "function_call"), false);
  writer.complete({ input_tokens: 10, output_tokens: 5 });
  validateOrder(events);
  const output = events.at(-1).response.output;
  assert.equal(output[0].phase, "commentary");
  assert.equal(output[1].namespace, "files");
  assert.equal(output[1].arguments, '{"path":"notes.txt"}');
  assert.equal(output[2].input, "raw\npatch");
});

test("a failed upstream response never executes buffered tools", () => {
  const { writer, events } = fixture();
  writer.addFunctionCall({ call_id: "call_unsafe", name: "write", arguments: "{}" });
  writer.fail("server_is_overloaded", "Try again later.");
  writer.complete({ input_tokens: 10, output_tokens: 5 });
  assert.equal(events.some((event) => event.item?.type === "function_call"), false);
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "server_is_overloaded");
});

test("summary none hides visible reasoning but preserves its replay carrier", () => {
  const { writer, events } = fixture(false);
  writer.reasoningDelta("Private model reasoning");
  writer.endReasoning("synthetic-carrier");
  writer.complete({ input_tokens: 10, output_tokens: 5 });
  assert.equal(events.some((event) => event.type.includes("reasoning_summary")), false);
  assert.deepEqual(events.at(-1).response.output[0].summary, []);
  assert.equal(events.at(-1).response.output[0].encrypted_content, "synthetic-carrier");
});

test("keepalives are JSON events and stop after completion", () => {
  const { writer, events } = fixture();
  writer.keepalive();
  assert.equal(events.at(-1).type, "keepalive");
  writer.textDelta("Done.");
  writer.complete({ input_tokens: 1, output_tokens: 1 });
  const count = events.length;
  writer.keepalive();
  assert.equal(events.length, count);
});

test("plaintext agent arguments, custom namespaces and end_turn are preserved", () => {
  const { writer, events } = fixture();
  writer.addFunctionCall({ call_id: "call_agent", namespace: "agents", name: "spawn_agent", arguments: '{"message":"Read the file."}' });
  writer.addCustomToolCall({ call_id: "call_custom", namespace: "scripts", name: "exec", input: "print(1)" });
  writer.complete({ input_tokens: 10, output_tokens: 5 }, false);
  const response = events.at(-1).response;
  assert.deepEqual(response.output[0].encrypted_function_args, []);
  assert.equal(response.output[0].arguments, '{"message":"Read the file."}');
  assert.equal(response.output[1].namespace, "scripts");
  assert.equal(response.end_turn, false);
});

test("stream failures preserve retry guidance", () => {
  const { writer, events } = fixture();
  writer.fail("rate_limit_exceeded", "Try later.", { "retry-after": "120" });
  assert.deepEqual(events.at(-1).response.error.headers, { "retry-after": "120" });
});
