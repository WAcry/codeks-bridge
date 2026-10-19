import assert from "node:assert/strict";
import test from "node:test";
import { retainedCompactionHistory, splitCompactionPrefix } from "../src/compaction-history.ts";

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const agent = (author: string, recipient: string, text: string) => ({
  type: "agent_message", author, recipient, content: [{ type: "input_text", text }],
});

test("source prefix keeps initial instructions and all incremental Lite declarations in order", () => {
  const initialTools = { type: "additional_tools", tools: [{ type: "namespace", name: "files", tools: [] }] };
  const extraTools = { type: "additional_tools", tools: [{ type: "namespace", name: "other", tools: [] }] };
  const system = message("system", "Source identity.");
  const developer = message("developer", "Source base instructions.");
  const user = message("user", "Task.");
  const later = message("developer", "Later instruction.");
  const checkpoint = { type: "compaction", encrypted_content: "synthetic-checkpoint" };
  const input = [initialTools, system, developer, user, later, extraTools, checkpoint];
  const original = structuredClone(input);
  assert.deepEqual(splitCompactionPrefix(input), {
    prefix: [initialTools, system, developer, extraTools], history: [user, later, checkpoint],
  });
  assert.deepEqual(input, original);
});

test("retention keeps real user messages while excluding context, ordinary developer, and tool history", () => {
  const user = message("user", "Implement upload.");
  const hook = message("user", '<hook_prompt hook_run_id="synthetic-run">Check the result.</hook_prompt>');
  const input = [
    message("user", "# AGENTS.md instructions for /project\n<INSTRUCTIONS>rules</INSTRUCTIONS>"),
    message("user", "<environment_context>environment</environment_context>"),
    message("user", "<skill>instructions</skill>"),
    message("user", "  <SKILL>instructions</SKILL>  "),
    message("user", "<external_note>context</external_note>"),
    message("user", '<codex_internal_context source="example">state</codex_internal_context>'),
    message("developer", "Mid-thread developer instruction."),
    message("assistant", "Work in progress."),
    { type: "function_call_output", name: "notification", output: "Notification." },
    { type: "function_call", name: "read", call_id: "synthetic-call", arguments: "{}" },
    { type: "reasoning", encrypted_content: "synthetic-reasoning" },
    { type: "compaction", encrypted_content: "synthetic-old-checkpoint" }, user, hook,
  ];
  assert.deepEqual(retainedCompactionHistory(input), [user, hook]);
});

test("agent retention excludes descendant progress, completions, and messages over 10k estimated tokens", () => {
  const task = agent("/root", "/root/worker", "Message Type: NEW_TASK\nWork.");
  const peer = agent("/root/other", "/root/worker", "Message Type: MESSAGE\nCoordinate.");
  const input = [
    task, peer,
    agent("/root/worker", "/root", "Message Type: MESSAGE\nProgress."),
    agent("/root/worker", "/root", "Message Type: CHANNEL_POST\nProgress."),
    agent("/root/worker", "/root", "Message Type: FINAL_ANSWER\nDone."),
    agent("/root", "/root/worker", "x".repeat(40_000)),
  ];
  assert.deepEqual(retainedCompactionHistory(input), [task, peer]);
});

test("newest messages consume the 64k budget and the boundary preserves both ends", () => {
  const newest = message("user", "new");
  const input = [message("user", "old-old"), message("user", "middle1234"), newest];
  const original = structuredClone(input);
  assert.deepEqual(retainedCompactionHistory(input, 3), [message("user", "midd…1 tokens truncated…1234"), newest]);
  assert.deepEqual(input, original);
  const large = message("user", "a".repeat(256_000));
  assert.deepEqual(retainedCompactionHistory([message("user", "old"), large]), [large]);
});

test("UTF-8 boundary truncation preserves complete characters and multipart order", () => {
  const item = { type: "message", role: "user", content: [
    { type: "input_text", text: "中文边界内容末尾" }, { type: "input_text", text: "drop" },
  ] };
  assert.deepEqual(retainedCompactionHistory([item], 2), [message("user", "中…4 tokens truncated…尾")]);
});

test("string content supports filtering, token accounting, and boundary truncation", () => {
  const newest = { type: "message", role: "user", content: "new" };
  const input = [
    { type: "message", role: "user", content: "<skill>instructions</skill>" },
    { type: "message", role: "user", content: "old-old" },
    { type: "message", role: "user", content: "middle1234" }, newest,
  ];
  const original = structuredClone(input);
  assert.deepEqual(retainedCompactionHistory(input), input.slice(1));
  assert.deepEqual(retainedCompactionHistory(input, 3), [message("user", "midd…1 tokens truncated…1234"), newest]);
  assert.deepEqual(input, original);
  const simplified = { role: "user", content: "A user message with an implicit type." };
  const source = { role: "developer", content: "Source instructions." };
  assert.deepEqual(splitCompactionPrefix([source, simplified]), { prefix: [source], history: [simplified] });
  assert.deepEqual(retainedCompactionHistory([simplified]), [simplified]);
});

test("images consume a budget and retain resize notices with their source message", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,synthetic", detail: "low" };
  const pictured = { type: "message", role: "user", content: [
    { type: "input_text", text: "<image>" }, image, { type: "input_text", text: "</image>" },
    { type: "input_text", text: "tail" },
  ] };
  const notice = message("developer", "<image_resize_notice>Resized.</image_resize_notice>");
  assert.deepEqual(retainedCompactionHistory([pictured, notice]), [pictured, notice]);
  assert.deepEqual(retainedCompactionHistory([message("user", "old"), pictured], 2), [message("user", "tail")]);
  assert.deepEqual(retainedCompactionHistory([message("user", "old"), { ...pictured, content: [image] }], 2), []);
});

test("oversized agent boundary is dropped whole and older messages can use the remainder", () => {
  const old = message("user", "old");
  const task = agent("/root", "/worker", "Message Type: NEW_TASK\nLong enough to exceed a small budget.");
  assert.deepEqual(retainedCompactionHistory([old, task], 2), [old]);
});
