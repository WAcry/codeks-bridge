import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicTools } from "../src/backends/anthropic-tools.ts";
import { translateToolHistory } from "../src/tool-history.ts";

const fn = (name: string, description = name) => ({
  type: "function", name, description,
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
});
const declaration = (...tools: unknown[]) => ({ type: "additional_tools", role: "developer", tools });
const message = (role: string, content: string) => ({ type: "message", role, content });

test("inline tools keep prefix declarations at the top and later definition versions in order", () => {
  const request = {
    model: "claude", tools: [fn("lookup", "Original lookup.")],
    input: [
      declaration(fn("initial")),
      message("developer", "Initial instructions."),
      declaration(fn("lookup", "Initial lookup.")),
      message("user", "Read it."),
      message("assistant", "Read."),
      declaration(fn("lookup", "Updated lookup."), fn("write")),
      message("user", "Now write it."),
      declaration(fn("lookup", "Latest lookup.")),
    ],
  };
  const original = structuredClone(request);
  const result = buildAnthropicTools(request, "inline");
  assert.deepEqual(result.definitions.map((tool) => [tool.name, tool.description]), [
    ["lookup", "Initial lookup."], ["initial", "initial"],
  ]);
  assert(Array.isArray(result.input));
  const updates = result.input.filter((item) => item.type === "additional_tools");
  assert.deepEqual(updates.map((item) => item.tools.map((tool: any) => [tool.name, tool.description])), [
    [["lookup", "Updated lookup."], ["write", "write"]],
    [["lookup", "Latest lookup."]],
  ]);
  assert.deepEqual(updates[0].tools[0].input_schema.required, ["path"]);
  assert.equal(result.tools.get(undefined, "lookup")?.description, "Latest lookup.");
  assert.equal(result.tools.entries.length, 3);
  assert.deepEqual(request, original);
});

test("inline tool names remain stable when later identities collide or change namespace spelling", () => {
  const request = {
    model: "claude", input: [
      declaration({ type: "namespace", name: "files", tools: [fn("read")] }),
      message("user", "Read."),
      declaration(fn("files__read"), { type: "namespace", name: "functions", tools: [fn("lookup")] }),
      message("assistant", "Done."),
      declaration({ type: "namespace", name: "files", tools: [fn("read", "Updated.")] }, fn("lookup", "Newest.")),
    ],
  };
  const first = buildAnthropicTools({ ...request, input: request.input.slice(0, 2) }, "inline");
  const result = buildAnthropicTools(request, "inline");
  assert.deepEqual(result.definitions, first.definitions);
  assert.equal(result.tools.flatFor("files", "read"), "files__read");
  assert.equal(result.tools.flatFor(undefined, "files__read"), "files__read_2");
  assert.equal(result.tools.flatFor(undefined, "lookup"), "functions__lookup");
  assert(Array.isArray(result.input));
  const updates = result.input.filter((item) => item.type === "additional_tools");
  assert.deepEqual(updates.map((item) => item.tools.map((tool: any) => tool.name)), [
    ["files__read_2", "functions__lookup"], ["files__read", "functions__lookup"],
  ]);
  assert.equal(updates[0].tools[1].description, "lookup");
  assert.equal(updates[1].tools[1].description, "Newest.");
});

test("top-level mode keeps the existing cumulative tools contract", () => {
  const request = {
    model: "claude", tools: [fn("read", "Original.")], input: [
      message("user", "Read."),
      declaration(fn("read", "Updated."), fn("write")),
      message("assistant", "Done."),
    ],
  };
  const result = buildAnthropicTools(request, "top_level");
  assert.deepEqual(result.input, [request.input[0], request.input[2]]);
  assert.deepEqual(result.definitions.map((tool) => [tool.name, tool.description]), [
    ["read", "Updated."], ["write", "write"],
  ]);
});

test("inline tools preserve grammar conversion, omit hosted-only batches, and reject malformed declarations", () => {
  const result = buildAnthropicTools({
    model: "claude", input: [
      message("user", "Use the new tool."),
      declaration({ type: "web_search" }),
      declaration({ type: "custom", name: "edit", format: { type: "grammar", syntax: "regex", definition: "EDIT .+" } }),
    ],
  }, "inline");
  assert.equal(result.definitions.length, 0);
  assert(Array.isArray(result.input));
  assert.equal(result.input.length, 2);
  assert.match(result.input[1].tools[0].description, /EDIT \.\+/);
  assert.deepEqual(result.input[1].tools[0].input_schema.required, ["input"]);
  for (const mode of ["inline", "top_level"] as const) {
    assert.throws(() => buildAnthropicTools({
      model: "claude", input: [{ type: "additional_tools" }],
    }, mode), /requires a tools array/);
  }
});

test("inline declarations follow a complete parallel tool exchange with reminders in original order", () => {
  const call = (id: string) => ({ type: "function_call", call_id: id, name: "read", arguments: "{}" });
  const result = (id: string) => ({ type: "function_call_output", call_id: id, output: id });
  const request = {
    model: "claude", tools: [fn("read")], input: [
      message("user", "Read both."),
      call("a"), call("b"),
      declaration(fn("write")), message("developer", "Keep the filenames."),
      result("a"),
      declaration(fn("read", "Updated.")),
      result("b"),
    ],
  };
  const { input } = buildAnthropicTools(request, "inline");
  assert(Array.isArray(input));
  assert.deepEqual(translateToolHistory(input), [
    input[0], input[1], input[2], input[5], input[7], input[3], input[4], input[6],
  ]);
  // An incomplete exchange is not repaired by moving its declarations.
  const incomplete = input.slice(0, -1);
  assert.deepEqual(translateToolHistory(incomplete), incomplete);
});
