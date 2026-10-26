import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeepSeekOptions } from "../src/adapter-options.ts";
import { buildCatalog } from "../src/catalog.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { buildDeepSeekRequest, runDeepSeek } from "../src/backends/deepseek.ts";
import type { BackendContext } from "../src/types.ts";
import { ResponseWriter } from "../src/writer.ts";

const titleSchema = {
  type: "object",
  properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
  required: ["title"],
  additionalProperties: false,
};

function config() {
  return validateConfig({
    upstreams: { a: { base_url: "https://example.com/v1" } },
    models: { flash: { upstream: "a", catalog: "deepseek-flash", model: "deployment-a" } },
  });
}

function context(mode?: "native" | "json_mode"): BackendContext {
  const c = config();
  if (mode) c.models.flash.adapters = { "deepseek-chat": { structured_output: mode } };
  return {
    route: resolveModel(validateConfig(c), "flash"),
    signal: new AbortController().signal,
    request: {
      model: "flash",
      instructions: "Give a brief title for the task.",
      input: [{ type: "message", role: "user", content: "Fix the tool protocol conversion." }],
      text: { format: { type: "json_schema", name: "codex_output_schema", schema: structuredClone(titleSchema), strict: true } },
    },
  };
}

test("DeepSeek structured output is opt-in, resolves model over connection, and does not change provenance or catalog", () => {
  const c = config();
  const before = resolveModel(c, "flash");
  const catalog = buildCatalog(c);
  assert.deepEqual(resolveDeepSeekOptions(before), { structured_output: "native" });
  c.upstreams.a.adapters = { "deepseek-chat": { structured_output: "json_mode" } };
  assert.deepEqual(resolveDeepSeekOptions(resolveModel(validateConfig(c), "flash")), { structured_output: "json_mode" });
  c.models.flash.adapters = { "deepseek-chat": { structured_output: "native" } };
  const route = resolveModel(validateConfig(c), "flash");
  assert.deepEqual(resolveDeepSeekOptions(route), { structured_output: "native" });
  assert.deepEqual(route.origin, before.origin);
  assert.deepEqual(buildCatalog(c), catalog);
});

test("DeepSeek settings reject misspellings, invalid values, and another model's adapter", () => {
  for (const scope of ["upstreams", "models"] as const) {
    for (const settings of [null, [], { structured_output: true }, { structured_output: "auto" }, { structure_output: "native" }]) {
      const c = config();
      const target = scope === "upstreams" ? c.upstreams.a : c.models.flash;
      Object.assign(target, { adapters: { "deepseek-chat": settings } });
      assert.throws(() => validateConfig(c), /deepseek-chat/);
    }
  }
  const c = config();
  c.models.flash.catalog = "claude-sonnet-5-5";
  c.upstreams.a.adapters = { "deepseek-chat": { structured_output: "json_mode" } };
  assert.equal(validateConfig(c), c);
  c.models.flash.adapters = c.upstreams.a.adapters;
  assert.throws(() => validateConfig(c), /deepseek-chat does not match the model adapter claude-messages/);
});

test("native structured output preserves the schema and does not add a format message", () => {
  const ctx = context();
  const { body } = buildDeepSeekRequest(ctx);
  assert.deepEqual(body.response_format, {
    type: "json_schema", json_schema: { name: "codex_output_schema", schema: titleSchema, strict: true },
  });
  assert.equal(body.messages.length, 2);
});

test("JSON mode appends the complete title schema while preserving the request and prior prefix", () => {
  const ctx = context("json_mode");
  const original = structuredClone(ctx.request);
  const native = buildDeepSeekRequest(context()).body;
  const { body } = buildDeepSeekRequest(ctx);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.messages.slice(0, -1), native.messages);
  assert.equal(body.messages.at(-1).role, "system");
  const instruction = body.messages.at(-1).content as string;
  assert.match(instruction, /single JSON object/);
  assert.deepEqual(JSON.parse(instruction.slice(instruction.indexOf("\n") + 1)), titleSchema);
  assert.deepEqual(ctx.request, original);
  assert(!Object.hasOwn(body.response_format, "strict"));
});

test("JSON mode leaves normal and JSON-object requests alone and compaction has no format suffix", () => {
  const ctx = context("json_mode");
  const messages = buildDeepSeekRequest(context()).body.messages;
  for (const format of [undefined, { type: "text" }, { type: "json_object" }]) {
    ctx.request.text = format ? { format } : undefined;
    const body = buildDeepSeekRequest(ctx).body;
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.response_format, format?.type === "json_object" ? { type: "json_object" } : undefined);
  }
  ctx.request.text = context().request.text;
  ctx.compacting = true;
  ctx.route.upstream.options = { response_format: { type: "json_object" } };
  const body = buildDeepSeekRequest(ctx).body;
  assert.deepEqual(body.messages, messages);
  assert.equal(body.response_format, undefined);
});

test("explicit native format options take precedence without a contradictory schema reminder", () => {
  const ctx = context("json_mode");
  const messages = buildDeepSeekRequest(context()).body.messages;
  ctx.route.upstream.options = { response_format: { type: "json_object" } };
  assert.deepEqual(buildDeepSeekRequest(ctx).body.response_format, { type: "json_object" });
  assert.deepEqual(buildDeepSeekRequest(ctx).body.messages, messages);
  ctx.route.config.options = { response_format: { type: "json_schema", json_schema: { name: "other", schema: { type: "object" } } } };
  const body = buildDeepSeekRequest(ctx).body;
  assert.deepEqual(body.response_format, ctx.route.config.options.response_format);
  assert.deepEqual(body.messages, messages);
});

test("JSON-mode schema conversion rejects a missing or invalid schema rather than inventing a format", () => {
  for (const schema of [undefined, null, [], "object"]) {
    const ctx = context("json_mode");
    ctx.request.text.format.schema = schema;
    assert.throws(() => buildDeepSeekRequest(ctx), /requires a schema object/);
  }
});

test("JSON-mode title request reaches Chat once and its JSON text survives the Responses writer", async () => {
  const ctx = context("json_mode");
  let calls = 0;
  ctx.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(body.messages.at(-1).content, /"maxLength":36/);
    return new Response([
      { choices: [{ index: 0, delta: { content: '{"title":"Fix tool conversion"}' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 8 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const writer = new ResponseWriter({ write() {} }, { model: "flash" });
  const result = await runDeepSeek(ctx, writer);
  writer.complete(result.usage, result.endTurn);
  assert.equal(calls, 1);
  const message = writer.outputItems.find(item => item.type === "message");
  assert.deepEqual(JSON.parse(message?.content[0].text), { title: "Fix tool conversion" });
});
