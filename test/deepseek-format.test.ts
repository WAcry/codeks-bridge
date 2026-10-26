import assert from "node:assert/strict";
import test from "node:test";
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

function context(): BackendContext {
  const c = config();
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

test("DeepSeek defaults to JSON mode with the complete title schema and unchanged prior prefix", () => {
  const ctx = context();
  const original = structuredClone(ctx.request);
  const plain = context();
  delete plain.request.text;
  const prefix = buildDeepSeekRequest(plain).body.messages;
  const { body } = buildDeepSeekRequest(ctx);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.messages.slice(0, -1), prefix);
  assert.equal(body.messages.at(-1).role, "system");
  const instruction = body.messages.at(-1).content as string;
  assert.match(instruction, /single JSON object/);
  assert.deepEqual(JSON.parse(instruction.slice(instruction.indexOf("\n") + 1)), titleSchema);
  assert.deepEqual(ctx.request, original);
  assert(!Object.hasOwn(body.response_format, "strict"));
});

test("JSON mode leaves normal and JSON-object requests alone and compaction has no format suffix", () => {
  const ctx = context();
  const plain = context();
  delete plain.request.text;
  const messages = buildDeepSeekRequest(plain).body.messages;
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
  const ctx = context();
  const plain = context();
  delete plain.request.text;
  const messages = buildDeepSeekRequest(plain).body.messages;
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
    const ctx = context();
    ctx.request.text.format.schema = schema;
    assert.throws(() => buildDeepSeekRequest(ctx), /requires a schema object/);
  }
});

test("JSON-mode title request reaches Chat once and its JSON text survives the Responses writer", async () => {
  const ctx = context();
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
