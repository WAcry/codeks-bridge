import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { buildAnthropicRequest } from "../src/backends/anthropic.ts";
import { buildDeepSeekRequest } from "../src/backends/deepseek.ts";
import { buildGeminiRequest } from "../src/backends/gemini.ts";
import { responsesBody } from "../src/backends/responses.ts";
import { encodeCompaction, encodeReasoning } from "../src/carrier.ts";
import { CompactionHandoffStore } from "../src/compaction-handoff.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { prepareHistory } from "../src/history.ts";
import { createBridgeServer } from "../src/server.ts";
import type { Backend, BackendContext, ResolvedModel } from "../src/types.ts";

const aliases = ["gpt", "claude", "deepseek", "gemini"] as const;
const stateTypes = ["reasoning", "compaction", "compaction_summary"];
const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const opaque = [
  { type: "reasoning", id: "rs_external", encrypted_content: "synthetic-external-reasoning", summary: [{ type: "summary_text", text: "Visible reasoning" }], future: { retain: true } },
  { type: "reasoning", id: "rs_summary_only", summary: [{ type: "summary_text", text: "No ciphertext" }] },
  { type: "reasoning", id: "rs_future", encrypted_content: "cxbr9:synthetic-future-envelope" },
  { type: "reasoning", id: "rs_unreadable", encrypted_content: "cxbr1:broken" },
  { type: "compaction", id: "cmp_external", encrypted_content: "synthetic-external-checkpoint", status: "completed", future: [1, 2] },
  { type: "compaction_summary", id: "cmp_summary", encrypted_content: "synthetic-other-checkpoint", extra: "retained" },
  { type: "compaction", id: "cmp_unreadable", encrypted_content: "cxbc1:broken" },
];

function configuration(policy?: unknown, base = "https://example.com/v1") {
  return validateConfig({
    upstreams: { example: { base_url: base } },
    models: Object.fromEntries(aliases.map((alias) => [alias, {
      upstream: "example", model: `${alias}-deployment`,
      catalog: { gpt: "gpt-6.1-sol", claude: "claude-sonnet-5-5", deepseek: "deepseek-flash", gemini: "gemini-3.8-flash" }[alias],
      ...(policy === undefined ? {} : { replay: { unrecognized: policy } }),
    }])),
  });
}

function context(route: ResolvedModel, input: Record<string, any>[]): BackendContext {
  return { route, request: { model: route.slug, input }, signal: new AbortController().signal };
}

function requestBody(ctx: BackendContext): Record<string, any> {
  if (ctx.route.profile.api === "responses") return responsesBody(ctx);
  if (ctx.route.profile.api === "anthropic") return buildAnthropicRequest(ctx).body;
  if (ctx.route.profile.api === "gemini") return buildGeminiRequest(ctx).body;
  return buildDeepSeekRequest(ctx).body;
}

function outgoingState(body: Record<string, any>): Record<string, any>[] {
  if (body.input) return body.input.filter((item: any) => stateTypes.includes(item.type));
  if (body.contents) return body.contents.flatMap((item: any) => item.parts).filter((item: any) => stateTypes.includes(item.type));
  return body.messages.flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
    .filter((item: any) => stateTypes.includes(item.type));
}

test("unrecognized state defaults to passthrough and validates its explicit policy", () => {
  for (const alias of aliases) {
    assert.equal(resolveModel(configuration(), alias).replay.unrecognized, "passthrough");
    for (const policy of ["passthrough", "drop", "error"]) {
      assert.equal(resolveModel(configuration(policy), alias).replay.unrecognized, policy);
      assert.deepEqual(resolveModel(configuration(policy), alias).origin, resolveModel(configuration(), alias).origin);
    }
  }
  for (const invalid of [null, false, {}, [], "ignore", ""]) {
    assert.throws(() => configuration(invalid), /unrecognized/);
  }
});

test("all adapters pass unrecognized state without decoding or losing fields", () => {
  const input = [message("user", "Before"), opaque[0], message("assistant", "Between"), ...opaque.slice(1), message("user", "After")];
  const original = structuredClone(input);
  for (const alias of aliases) {
    const route = resolveModel(configuration(), alias);
    assert.deepEqual(prepareHistory(input, route), input);
    const body = requestBody(context(route, input));
    assert.deepEqual(outgoingState(body), opaque);
    if (route.profile.api === "gemini") {
      for (const item of body.contents) {
        if (item.parts.some((part: any) => stateTypes.includes(part.type))) assert.equal(item.role, "model");
      }
    } else if (route.profile.api !== "responses") {
      for (const item of body.messages) {
        if (Array.isArray(item.content) && item.content.some((part: any) => stateTypes.includes(part.type))) {
          assert.equal(item.role, "assistant");
        }
      }
      assert(!body.messages.some((item: any) => typeof item.content === "string" && item.content.includes("synthetic-external")));
    }
    assert.deepEqual(input, original);
  }
});

test("drop and error policies apply to every unrecognized state type on every adapter", () => {
  for (const alias of aliases) {
    const input = [message("user", "Before"), ...opaque, message("user", "After")];
    const drop = resolveModel(configuration("drop"), alias);
    assert.deepEqual(prepareHistory(input, drop), [input[0], input.at(-1)]);
    assert.deepEqual(outgoingState(requestBody(context(drop, input))), []);
    const error = resolveModel(configuration("error"), alias);
    for (const item of opaque) {
      assert.throws(() => requestBody(context(error, [item])), /unrecognized/i);
    }
  }
});

test("unrecognized policy does not replace source and format rules for decoded carriers", () => {
  for (const policy of ["passthrough", "drop", "error"]) {
    const config = configuration(policy);
    const route = resolveModel(config, "gpt");
    const known = { type: "reasoning", encrypted_content: encodeReasoning({ source: route.origin, format: route.profile.reasoning_format, data: "synthetic-native-reasoning" }) };
    const foreign = { type: "reasoning", encrypted_content: encodeReasoning({ source: { ...route.origin, id: "synthetic-other-source" }, format: route.profile.reasoning_format, data: "synthetic-foreign-reasoning" }) };
    const unsupported = { type: "reasoning", encrypted_content: encodeReasoning({ source: route.origin, format: "synthetic.unsupported.format", data: "synthetic-other-format" }) };
    const native = { type: "compaction", id: "cmp_known", encrypted_content: "synthetic-native-checkpoint" };
    const checkpoint = { type: "compaction", encrypted_content: encodeCompaction({ summary: "Portable summary", native: { source: route.origin, format: route.profile.native_compaction_format!, data: native } }) };
    const input = [known, foreign, unsupported, checkpoint];
    const original = structuredClone(input);
    const body = responsesBody(context(route, input));
    assert.deepEqual(body.input, [
      { type: "reasoning", summary: [], encrypted_content: "synthetic-native-reasoning" },
      { type: "compaction", encrypted_content: "synthetic-native-checkpoint" },
    ]);
    const other = prepareHistory(input, resolveModel(config, "claude"));
    assert.equal(other.length, 1);
    assert.match(other[0].content[0].text, /Portable summary$/);
    assert.deepEqual(input, original);
  }
});

test("opaque checkpoints do not trigger a handoff or need their original source configured", async () => {
  const config = configuration();
  const never: Backend = async () => assert.fail("Opaque checkpoints cannot generate a bridge handoff");
  const store = new CompactionHandoffStore(config, { "gpt-responses": never, "claude-messages": never, "deepseek-chat": never, "gemini-native": never });
  for (const alias of aliases) {
    const ctx = context(resolveModel(config, alias), opaque);
    assert.equal(await store.materialize(ctx), ctx.request);
  }
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("error policy rejects mixed history before starting a deferred handoff", async t => {
  let upstreamCalls = 0;
  const upstream = createServer((_req, res) => {
    upstreamCalls++;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No upstream call should be made" } }));
  });
  const base = await listen(upstream);
  t.after(() => close(upstream));
  const config = configuration(undefined, `${base}/v1`);
  config.models.claude.replay = { unrecognized: "error" };
  const source = resolveModel(config, "gpt");
  const checkpoint = { type: "compaction", encrypted_content: encodeCompaction({
    native: {
      source: source.origin, format: source.profile.native_compaction_format!,
      data: { type: "compaction", encrypted_content: "synthetic-deferred-checkpoint" },
    },
    handoff: { prefix: [], parameters: { model: "gpt" }, responsesLite: true },
  }) };
  const bridge = createBridgeServer(config);
  const url = await listen(bridge);
  t.after(() => close(bridge));
  const response = await fetch(`${url}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude", stream: true, input: [checkpoint, opaque[0], message("user", "Continue")] }),
  });
  assert.equal(response.status, 400);
  const result = await response.json() as any;
  assert.match(result.error.message, /replay\.unrecognized is set to error/);
  assert.equal(upstreamCalls, 0);
});

test("upstream rejection of opaque state reaches the client through the existing HTTP error contract", async t => {
  const seen: Record<string, any>[] = [];
  const failure = JSON.stringify({ error: { type: "synthetic_state_incompatible", message: "Synthetic upstream cannot interpret this state", detail: { preserve: true } } });
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(422, { "content-type": "application/json", "x-synthetic-state-error": "preserved" });
    res.end(failure);
  });
  const base = await listen(upstream);
  t.after(() => close(upstream));
  const bridge = createBridgeServer(configuration(undefined, `${base}/v1`));
  const url = await listen(bridge);
  t.after(() => close(bridge));
  for (const alias of aliases) {
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: alias, stream: true, input: [message("user", "Before"), ...opaque, message("user", "After")] }),
    });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("x-synthetic-state-error"), "preserved");
    if (alias === "gpt") assert.equal(await response.text(), failure);
    else {
      const result = await response.json() as any;
      assert.equal(result.error.code, "invalid_prompt");
      assert.deepEqual(result.error.upstream, { status: 422, body: JSON.parse(failure) });
    }
    assert.deepEqual(outgoingState(seen.at(-1)!), opaque);
  }
  assert.equal(seen.length, aliases.length);
});
