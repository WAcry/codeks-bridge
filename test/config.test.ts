import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, resolveModel } from "../src/config.ts";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { upstreamHeaders } from "../src/auth.ts";
import { reasoningEffort } from "../src/profiles.ts";

const config = () => validateConfig({
  upstreams: { a: { base_url: "https://example.com/v1" } },
  models: { first: { upstream: "a", adapter: "deepseek-chat", model: "deployment-a", context_window: 100000 } },
});

test("state provenance survives alias and policy changes but distinguishes actual targets", () => {
  const c = config();
  c.models.alias = { ...c.models.first };
  const before = resolveModel(c, "first").origin;
  assert.deepEqual(resolveModel(c, "alias").origin, before);
  c.models.second = { ...c.models.first, model: "deployment-b" };
  c.models.first.replay = { reasoning_from: ["second"] };
  c.models.first.reasoning = { effort_map: { high: "max" } };
  assert.deepEqual(resolveModel(c, "first").origin, before);
  assert.notEqual(resolveModel(c, "second").origin.id, before.id);
  c.upstreams.a.base_url += "/";
  assert.deepEqual(resolveModel(c, "first").origin, before);
  c.upstreams.a.base_url = "https://region.example.com/v1";
  assert.notEqual(resolveModel(c, "first").origin.id, before.id);
  assert(!JSON.stringify(before).includes("example.com"));
  assert.throws(() => resolveModel(c, "toString"), /Unknown model/);
});

test("configuration validates local references and formats without guessing endpoint support", () => {
  const c = config();
  c.models.second = { ...c.models.first, model: "unrecognized-new-deployment", replay: { reasoning_from: ["first"] } };
  assert.equal(validateConfig(c), c);
  c.models.second.replay!.reasoning_from = ["missing"];
  assert.throws(() => validateConfig(c), /unknown replay source/);
  c.models.second.replay!.reasoning_from = ["first"];
  c.models.second.adapter = "gpt-responses";
  assert.throws(() => validateConfig(c), /cannot decode/);
  delete c.models.second.replay;
  c.models.first.compaction = { mode: "dual" };
  assert.throws(() => validateConfig(c), /native compaction representation/);
  delete c.models.first.compaction;
  c.upstreams.a.base_url = "https://key@example.com";
  assert.throws(() => validateConfig(c), /credentials/);
});

test("catalog and adapter share configured efforts while unknown request values reach upstream", () => {
  const c = config();
  c.models.first.reasoning = { default_effort: "low", effort_map: { low: "fast", high: "thorough" } };
  c.models.first.input_modalities = ["text"];
  validateConfig(c);
  const route = resolveModel(c, "first");
  assert.equal(reasoningEffort(route), "fast");
  assert.equal(reasoningEffort(route, "high"), "thorough");
  assert.equal(reasoningEffort(route, "new-native-value"), "new-native-value");
  const result = buildCatalog(c, { models: [{ slug: "template", visibility: "list", multi_agent_version: "v2", use_responses_lite: true, tool_mode: "code_mode_only", base_instructions: "Synthetic client instructions", default_reasoning_level: "max", supported_reasoning_levels: [{ effort: "max" }], input_modalities: ["text", "image"] }] });
  const entry = result.models[0];
  assert.equal(entry.use_responses_lite, false);
  assert.equal(entry.multi_agent_version, "v2");
  assert.equal(entry.context_window, 100000);
  assert.equal(entry.base_instructions, "Synthetic client instructions");
  assert.equal(entry.default_reasoning_level, "low");
  assert.deepEqual(entry.supported_reasoning_levels.map((p: any) => p.effort), ["low", "high"]);
  assert.deepEqual(entry.input_modalities, ["text"]);
  assert.match(configSnippet(c, "/tmp/catalog.json"), /remote_compaction = "v2"/);
});

test("native compaction generation and replay are independently configured", () => {
  const c = config();
  c.models.first.adapter = "gpt-responses";
  c.models.first.compaction = { mode: "summary", native_replay: true };
  assert.deepEqual(resolveModel(validateConfig(c), "first").compaction, { mode: "summary", native_replay: true });
  c.models.first.compaction = { mode: "dual", native_replay: false };
  assert.deepEqual(resolveModel(validateConfig(c), "first").compaction, { mode: "dual", native_replay: false });
});

test("credential commands keep diagnostics private and adapters own protocol headers", async () => {
  await assert.rejects(upstreamHeaders({ base_url: "https://example.com", api_key_command: [process.execPath, "-e", "console.error('synthetic-sensitive-value');process.exit(1)"] }, "responses", new AbortController().signal), error => {
    assert.equal((error as Error).message, "Credential command failed"); return true;
  });
  const upstream = { ...config().upstreams.a, headers: { "Content-Type": "application/json;charset=utf-8" } };
  const signal = new AbortController().signal;
  assert.equal((await upstreamHeaders(upstream, "anthropic", signal)).get("anthropic-version"), "2023-06-01");
  assert.equal((await upstreamHeaders(upstream, "responses", signal)).get("anthropic-version"), null);
  assert.equal((await upstreamHeaders(upstream, "responses", signal)).get("content-type"), "application/json;charset=utf-8");
});


test("catalog resolves codeks Ultra through the configured map instead of the template", () => {
  const c = config();
  c.models.first.reasoning = { default_effort: "high", effort_map: { low: "fast", high: "thorough", ultra: "thorough" } };
  validateConfig(c);
  const entry = buildCatalog(c, { models: [{ slug: "template", multi_agent_reasoning_effort: "xhigh" }] }).models[0];
  assert.equal(entry.multi_agent_reasoning_effort, "high");
  const route = resolveModel(c, "first");
  assert.equal(reasoningEffort(route, entry.multi_agent_reasoning_effort), reasoningEffort(route, "ultra"));
  c.models.first.reasoning.effort_map!.ultra = "unreachable-only-through-ultra";
  assert.throws(() => validateConfig(c), /ultra must map/);
});
