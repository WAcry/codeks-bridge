import assert from "node:assert/strict";
import test from "node:test";
import { baseFlatName, buildToolSet, cleanSchema, safeCallId } from "../src/tools.ts";

const fn = (name: string) => ({ type: "function", name, parameters: { type: "object", properties: {} } });

test("tool names remain readable, with suffixes only for actual collisions", () => {
  const tools = buildToolSet([
    fn("lookup"),
    { type: "namespace", name: "files", tools: [fn("read")] },
    fn("files__read"),
    fn("odd.name"),
    fn("odd name"),
    { type: "namespace", name: "mcp__files_", tools: [fn("write")] },
    { type: "web_search" },
  ]);
  assert.deepEqual(tools.entries.map((tool) => tool.flatName), [
    "lookup", "files__read", "files__read_2", "odd_name", "odd_name_2", "mcp__files_write",
  ]);
  assert.equal(tools.flatFor("files", "read"), "files__read");
  assert.equal(tools.flatFor(undefined, "files__read"), "files__read_2");
  assert.equal(tools.resolve("files__read")?.namespace, "files");
  assert.equal(tools.resolve("unknown"), undefined);
});

test("long tool names retain a readable prefix and distinct deterministic hashes", () => {
  const first = baseFlatName("namespace", "x".repeat(100) + "a");
  const second = baseFlatName("namespace", "x".repeat(100) + "b");
  assert.equal(first.length, 64);
  assert.match(first, /^namespace__x+_[0-9a-f]{8}$/);
  assert.notEqual(first, second);
  assert.equal(first, baseFlatName("namespace", "x".repeat(100) + "a"));
});

test("custom tools preserve Lark and regex instructions and accept one raw input string", () => {
  const grammar = 'start: "hello"';
  const tools = buildToolSet([
    { type: "custom", name: "edit", description: "Edit a file.", format: { type: "grammar", syntax: "lark", definition: grammar } },
    { type: "custom", name: "number", format: { type: "grammar", syntax: "regex", definition: "^[0-9]+$" } },
    { type: "custom", name: "script" },
  ]);
  assert.match(tools.entries[0].description, /Edit a file\./);
  assert.ok(tools.entries[0].description.includes(grammar));
  assert.ok(tools.entries[1].description.includes("^[0-9]+$"));
  assert.deepEqual(tools.entries[2].parameters, {
    type: "object", properties: { input: { type: "string", description: "The raw tool input." } },
    required: ["input"], additionalProperties: false,
  });
});

test("schema cleanup removes encrypted keywords but preserves properties and data with that name", () => {
  const schema = {
    type: "object", encrypted: true,
    properties: {
      encrypted: { type: "boolean", description: "A normal field." },
      prompt: { type: "string", encrypted: true },
      nested: { anyOf: [{ type: "array", items: { type: "string", encrypted: false } }] },
    },
    default: { encrypted: true },
    examples: [{ encrypted: true }],
    $defs: { nested: { encrypted: true, type: "string" } },
  };
  const cleaned: any = cleanSchema(schema);
  assert.equal(cleaned.encrypted, undefined);
  assert.equal(cleaned.properties.prompt.encrypted, undefined);
  assert.equal(cleaned.properties.nested.anyOf[0].items.encrypted, undefined);
  assert.equal(cleaned.$defs.nested.encrypted, undefined);
  assert.deepEqual(cleaned.properties.encrypted, schema.properties.encrypted);
  assert.deepEqual(cleaned.default, { encrypted: true });
  assert.deepEqual(cleaned.examples, [{ encrypted: true }]);
  assert.equal(schema.encrypted, true);
});

test("call ids preserve valid ids and normalize unsupported characters and length", () => {
  assert.equal(safeCallId("call_123-abc"), "call_123-abc");
  assert.notEqual(safeCallId("call/a"), safeCallId("call:a"));
  assert.match(safeCallId("call with spaces/" + "x".repeat(90)), /^[a-zA-Z0-9_-]{1,64}$/);
});
