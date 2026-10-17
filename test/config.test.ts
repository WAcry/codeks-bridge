import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, resolveModel } from "../src/config.ts";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { upstreamHeaders } from "../src/auth.ts";

const config = () => validateConfig({ upstreams: { a: { api: "chat", base_url: "https://example.com/v1" } }, models: { first: { upstream: "a", model: "model-a", context_window: 100000 } } });
test("model identity uses endpoint and real model, not aliases or credentials", () => {
  const c = config();
  c.models.alias = { ...c.models.first };
  assert.equal(resolveModel(c, "alias").key, resolveModel(c, "first").key);
  c.models.second = { ...c.models.first, model: "model-b" };
  assert.notEqual(resolveModel(c, "second").key, resolveModel(c, "first").key);
  const before = resolveModel(c, "first").key;
  c.upstreams.a.base_url = "https://region.example.com/v1";
  assert.notEqual(before, resolveModel(c, "first").key);
  assert.throws(() => resolveModel(c, "toString"));
});
test("configuration rejects invalid routes and credentials in URLs", () => {
  const c = config();
  c.upstreams.a.base_url = "https://key@example.com";
  assert.throws(() => validateConfig(c), /credentials/);
  assert.throws(() => validateConfig({ upstreams: {}, models: { a: { upstream: "missing", model: "x" } } }), /existing upstream/);
});
test("catalog keeps client protocol fields and sends complete tool definitions", () => {
  const c = config();
  const result = buildCatalog(c, { models: [{ slug: "template", visibility: "list", multi_agent_version: "v2", use_responses_lite: true, tool_mode: "code_mode_only", base_instructions: "Synthetic client instructions" }] });
  assert.equal(result.models[0].use_responses_lite, false);
  assert.equal(result.models[0].multi_agent_version, "v2");
  assert.equal(result.models[0].context_window, 100000);
  assert.equal(result.models[0].base_instructions, "Synthetic client instructions");
  assert.match(configSnippet(c, "/tmp/catalog.json"), /remote_compaction = "v2"/);
});
test("credential commands do not leak command stderr on failure", async () => {
  await assert.rejects(upstreamHeaders({ api: "responses", base_url: "https://example.com", api_key_command: [process.execPath, "-e", "console.error('synthetic-sensitive-value');process.exit(1)"] }, new AbortController().signal), error => {
    assert.equal((error as Error).message, "Credential command failed"); return true;
  });
});
