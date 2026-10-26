import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicRequest } from "../src/backends/anthropic.ts";
import { buildDeepSeekRequest } from "../src/backends/deepseek.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { baseFlatName, buildToolSet, cleanSchema, normalizeToolDeclarations, safeCallId } from "../src/tools.ts";

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

test("tool calls accept flat, dotted and unique bare names without changing declarations", () => {
  const tools = buildToolSet([
    { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }, fn("wait")] },
    { type: "namespace", name: "agents", tools: [fn("spawn_agent")] },
    { type: "namespace", name: "clock", tools: [fn("sleep")] },
    { type: "namespace", name: "inventory", tools: [fn("lookup")] },
    fn("request_user_input"),
  ]);
  const declared = structuredClone(tools.entries);
  for (const [namespace, name] of [
    ["functions", "exec"], ["functions", "wait"], ["agents", "spawn_agent"],
    ["clock", "sleep"], ["inventory", "lookup"], ["functions", "request_user_input"],
  ]) {
    const expected = tools.get(namespace, name);
    for (const spelling of [`${namespace}__${name}`, `${namespace}.${name}`, name]) {
      assert.equal(tools.resolve(spelling), expected);
      assert.deepEqual(tools.candidates(spelling), [expected]);
    }
  }
  assert.equal(tools.resolve("exec")?.kind, "custom");
  assert.equal(tools.resolve("spawn_agent")?.namespace, "agents");
  assert.equal(tools.resolve("request_user_input")?.namespace, undefined);
  assert.equal(tools.resolve("agents__spawn_agnt"), undefined);
  assert.equal(tools.resolve("AGENTS.spawn_agent"), undefined);
  assert.deepEqual(tools.entries, declared);
});

test("ambiguous aliases expose every candidate and never choose a default namespace", () => {
  const tools = buildToolSet([
    { type: "namespace", name: "functions", tools: [fn("read")] },
    { type: "namespace", name: "files", tools: [fn("read")] },
    { type: "namespace", name: "database", tools: [fn("read")] },
  ]);
  assert.equal(tools.resolve("read"), undefined);
  assert.deepEqual(tools.candidates("read").map((tool) => tool.flatName), ["functions__read", "files__read", "database__read"]);
  assert.equal(tools.resolve("functions.read"), tools.get("functions", "read"));
  assert.equal(tools.resolve("files__read"), tools.get("files", "read"));
  assert.equal(tools.resolve("database.read"), tools.get("database", "read"));
  assert.deepEqual(tools.candidates("missing"), []);
});

test("declared flat names take precedence over aliases even after a name collision", () => {
  const tools = buildToolSet([
    fn("read"),
    { type: "namespace", name: "files", tools: [fn("read")] },
    fn("files__read"),
  ]);
  assert.equal(tools.resolve("read"), tools.get(undefined, "read"));
  assert.deepEqual(tools.candidates("read"), [tools.get(undefined, "read")]);
  assert.equal(tools.resolve("files__read"), tools.get("files", "read"));
  assert.equal(tools.resolve("files__read_2"), tools.get(undefined, "files__read"));
  assert.equal(tools.resolve("functions.files__read"), tools.get(undefined, "files__read"));
});

test("aliases come from complete identities, including punctuation and hashed names", () => {
  const longName = "long_".repeat(20);
  const tools = buildToolSet([
    { type: "namespace", name: "files", tools: [fn("read.part")] },
    { type: "namespace", name: "files.read", tools: [fn("part")] },
    { type: "namespace", name: "mcp__files_", tools: [fn("write")] },
    { type: "namespace", name: "storage", tools: [fn(longName)] },
  ]);
  assert.equal(tools.resolve("files.read.part"), undefined);
  assert.equal(tools.candidates("files.read.part").length, 2);
  assert.equal(tools.resolve("files__read_part"), tools.get("files", "read.part"));
  assert.equal(tools.resolve("mcp__files_.write"), tools.get("mcp__files_", "write"));
  assert.equal(tools.resolve("mcp__files_write"), tools.get("mcp__files_", "write"));
  assert.equal(tools.resolve("mcp__files___write"), tools.get("mcp__files_", "write"));
  assert.equal(tools.resolve(`storage.${longName}`), tools.get("storage", longName));
  assert.equal(tools.resolve(`storage__${longName}`), tools.get("storage", longName));
  assert.equal(tools.resolve(longName), tools.get("storage", longName));
  assert.equal(tools.resolve(tools.get("storage", longName)!.flatName), tools.get("storage", longName));
});

test("aliases use the latest declaration while canonical names stay stable", () => {
  const tools = buildToolSet([
    { type: "custom", name: "exec", description: "Original." },
    { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Updated." }] },
    { type: "namespace", name: "remote", tools: [fn("exec")] },
  ]);
  assert.equal(tools.entries.length, 2);
  assert.equal(tools.resolve("functions__exec"), tools.get("functions", "exec"));
  assert.equal(tools.resolve("functions.exec")?.flatName, "exec");
  assert.match(tools.resolve("functions.exec")!.description, /^Updated\./);
  assert.equal(tools.resolve("exec"), tools.get(undefined, "exec"));
  assert.equal(tools.resolve("remote.exec"), tools.get("remote", "exec"));
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

test("Messages and DeepSeek preserve root references and composition schemas", () => {
  const config = validateConfig({
    upstreams: { example: { base_url: "https://api.example.com/v1" } },
    models: {
      messages: { upstream: "example", model: "claude-sonnet-5-5", catalog: "claude-sonnet-5-5" },
      chat: { upstream: "example", model: "deepseek-flash", catalog: "deepseek-flash" },
    },
  });
  const object = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };
  const cases = [
    {
      source: { $ref: "#/$defs/Args", $defs: { Args: { ...object, encrypted: true } } },
      expected: { type: "object", $ref: "#/$defs/Args", $defs: { Args: object } },
    },
    ...["allOf", "anyOf", "oneOf"].map((keyword) => ({
      source: { [keyword]: [{ ...object, properties: { path: { type: "string", encrypted: true } } }] },
      expected: { type: "object", [keyword]: [object] },
    })),
  ];
  for (const { source, expected } of cases) {
    const snapshot = structuredClone(source);
    for (const model of ["messages", "chat"]) {
      const context = {
        route: resolveModel(config, model),
        request: { model, input: "Read the file.", tools: [{ ...fn("read"), parameters: source }] },
        signal: new AbortController().signal,
      };
      const actual = model === "messages"
        ? buildAnthropicRequest(context).body.tools[0].input_schema
        : buildDeepSeekRequest(context).body.tools[0].function.parameters;
      assert.deepEqual(actual, expected);
    }
    assert.deepEqual(source, snapshot);
  }
});

test("Messages and DeepSeek preserve explicit function strict without adding defaults", () => {
  const config = validateConfig({
    upstreams: { example: { base_url: "https://api.example.com/v1" } },
    models: {
      messages: { upstream: "example", model: "claude-sonnet-5-5", catalog: "claude-sonnet-5-5" },
      chat: { upstream: "example", model: "deepseek-flash", catalog: "deepseek-flash" },
    },
  });
  const parameters = {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
  };
  const functions = [
    { ...fn("unspecified"), parameters },
    { ...fn("loose"), parameters, strict: false },
    { ...fn("exact"), parameters, strict: true },
  ];
  const input = [
    { type: "additional_tools", tools: [{ type: "namespace", name: "files", tools: functions }] },
    { type: "message", role: "user", content: "Read a file." },
  ];
  for (const model of ["messages", "chat"]) {
    const request = { model, input, tools: [...functions, { type: "custom", name: "script" }] };
    const snapshot = structuredClone(request);
    const context = { route: resolveModel(config, model), request, signal: new AbortController().signal };
    const body = model === "messages" ? buildAnthropicRequest(context).body : buildDeepSeekRequest(context).body;
    const definitions = JSON.parse(JSON.stringify(body)).tools.map((tool: any) => model === "messages" ? tool : tool.function);
    assert.deepEqual(definitions.map((tool: any) => [tool.name, Object.hasOwn(tool, "strict"), tool.strict]), [
      ["unspecified", false, undefined], ["loose", true, false], ["exact", true, true], ["script", false, undefined],
      ["files__unspecified", false, undefined], ["files__loose", true, false], ["files__exact", true, true],
    ]);
    assert.deepEqual(model === "messages" ? definitions[2].input_schema : definitions[2].parameters, parameters);
    assert.deepEqual(request, snapshot);
  }
});

test("Messages and DeepSeek replace strict settings with the latest declaration", () => {
  const config = validateConfig({
    upstreams: { example: { base_url: "https://api.example.com/v1" } },
    models: {
      messages: { upstream: "example", model: "claude-sonnet-5-5", catalog: "claude-sonnet-5-5" },
      chat: { upstream: "example", model: "deepseek-flash", catalog: "deepseek-flash" },
    },
  });
  const declaration = (strict?: boolean) => ({
    type: "additional_tools", tools: [{
      type: "namespace", name: "files", tools: [{ ...fn("read"), ...(strict === undefined ? {} : { strict }) }],
    }],
  });
  const input = [
    declaration(true), { role: "user", content: "First." }, { role: "assistant", content: "Done." },
    { role: "user", content: "Second." }, declaration(false), { role: "assistant", content: "Done." },
    { role: "user", content: "Third." }, declaration(),
  ];
  const snapshot = structuredClone(input);
  for (const model of ["messages", "chat"]) {
    const context = { route: resolveModel(config, model), request: { model, input }, signal: new AbortController().signal };
    const body = model === "chat" ? buildDeepSeekRequest(context).body : buildAnthropicRequest(context).body;
    const wire = JSON.parse(JSON.stringify(body));
    assert.equal(wire.tools.length, 1);
    const tool = model === "chat" ? wire.tools[0].function : wire.tools[0];
    assert.equal(tool.name, "files__read");
    assert.equal(Object.hasOwn(tool, "strict"), false);
  }
  assert.deepEqual(input, snapshot);
});

test("function schemas default only missing types and reject non-schema parameters", () => {
  const parameters = { type: "array", items: { type: "string" } };
  assert.deepEqual(buildToolSet([{ ...fn("explicit"), parameters }]).entries[0].parameters, parameters);
  for (const missing of [undefined, null]) {
    assert.deepEqual(buildToolSet([{ ...fn("no_args"), parameters: missing }]).entries[0].parameters,
      { type: "object", properties: {} });
  }
  for (const invalid of [true, false, 0, "object", []]) {
    assert.throws(() => buildToolSet([{ ...fn("invalid"), parameters: invalid }]), /must be a JSON Schema object/);
  }
});

test("call ids preserve valid ids and normalize unsupported characters and length", () => {
  assert.equal(safeCallId("call_123-abc"), "call_123-abc");
  assert.notEqual(safeCallId("call/a"), safeCallId("call:a"));
  assert.match(safeCallId("call with spaces/" + "x".repeat(90)), /^[a-zA-Z0-9_-]{1,64}$/);
});

test("Lite declarations merge changed members without losing siblings or mutating history", () => {
  const original = {
    model: "example", tools: [fn("initial")], input: [
      { type: "additional_tools", role: "developer", tools: [
        { type: "namespace", name: "files", tools: [fn("read"), fn("write")] },
        { type: "namespace", name: "functions", tools: [fn("lookup")] },
      ] },
      { type: "message", role: "user", content: "Read it." },
      { type: "additional_tools", role: "developer", tools: [
        { type: "namespace", name: "files", tools: [
          { ...fn("read"), description: "Updated.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          fn("list"),
        ] },
      ] },
      { type: "message", role: "developer", content: "The write tool is no longer available." },
    ],
  };
  const snapshot = structuredClone(original);
  const normalized = normalizeToolDeclarations(original);
  assert.deepEqual(normalized.input, [original.input[1], original.input[3]]);
  const tools = buildToolSet(normalized.tools);
  assert.deepEqual(tools.entries.map((tool) => tool.flatName), ["initial", "files__read", "files__write", "functions__lookup", "files__list"]);
  assert.equal(tools.get("files", "read")?.description, "Updated.");
  assert.deepEqual(tools.get("files", "read")?.parameters.required, ["path"]);
  assert.equal(tools.flatFor(undefined, "lookup"), "functions__lookup");
  assert.equal(tools.flatFor("", "lookup"), "functions__lookup");
  assert.equal(tools.get("functions", "initial")?.name, "initial");
  assert.deepEqual(original, snapshot);
});

test("Lite rejects malformed declaration arrays instead of silently losing tools", () => {
  assert.throws(() => normalizeToolDeclarations({ model: "example", input: [{ type: "additional_tools", role: "developer" }] }), /requires a tools array/);
});
