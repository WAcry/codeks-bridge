import assert from "node:assert/strict";
import test from "node:test";
import { splitCompactionPrefix } from "../src/compaction-history.ts";

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });

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


test("implicit message types preserve source instructions and the remaining history", () => {
  const source = { role: "developer", content: "Source instructions." };
  const user = { role: "user", content: "A user message with an implicit type." };
  assert.deepEqual(splitCompactionPrefix([source, user]), { prefix: [source], history: [user] });
});
