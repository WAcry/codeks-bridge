import assert from "node:assert/strict";
import test from "node:test";
import { responsesBody } from "../src/backends/responses.ts";
import { buildCatalog } from "../src/catalog.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { getCatalogEntry } from "../src/model-catalog.ts";
import { reasoningEffort } from "../src/profiles.ts";

test("legacy GPT catalogs retain their protocol, window, and reasoning differences", () => {
  const cases = [
    ["gpt-5.5", true, null, 272000, 272000, "2911", "medium", "xhigh"],
    ["gpt-daybreak-blue-latest", true, "v2", 272000, 872000, "3000", "low", "ultra"],
    ["gpt-daybreak-red-latest", true, "v2", 372000, 372000, "3000", "medium", "ultra"],
    ["codex-auto-review", true, "v1", 272000, 872000, "3000", "medium", "max"],
  ] as const;
  const config = validateConfig({
    upstreams: { test: { base_url: "https://example.com/v1" } },
    models: Object.fromEntries(cases.map(([key]) => [key, { catalog: key, upstream: "test", model: `deployment/${key}` }])),
  });
  const catalog = buildCatalog(config).models;
  for (const [key, lite, multiAgent, window, maxWindow, compHash, defaultEffort, highestEffort] of cases) {
    const entry = catalog.find(entry => entry.slug === key)!;
    const original = getCatalogEntry(key);
    assert.equal(original.source.tag, "rust-v0.164.0");
    if (key === "gpt-5.5") assert.match(original.adjustments[0], /Responses Lite/);
    else assert.deepEqual(original.adjustments, []);
    assert.deepEqual(entry.model_messages, original.model.model_messages);
    assert.equal(entry.use_responses_lite, lite);
    assert.equal(entry.tool_mode, key === "gpt-5.5" ? null : "code_mode_only");
    assert.equal(entry.multi_agent_version, multiAgent);
    assert.equal(entry.context_window, window);
    assert.equal(entry.max_context_window, maxWindow);
    assert.equal(entry.comp_hash, compHash);
    assert.equal(entry.default_reasoning_level, defaultEffort);
    assert.equal(entry.supported_reasoning_levels.at(-1).effort, highestEffort);
    const route = resolveModel(config, key);
    assert.equal(route.profile.id, "gpt-responses");
    assert.equal(reasoningEffort(route), defaultEffort);
    assert.equal(reasoningEffort(route, highestEffort), highestEffort === "ultra" ? "max" : highestEffort);
  }
});

test("GPT-Reserve reuses the Luna template with only identity and upgrade changes", () => {
  const reserve = getCatalogEntry("gpt-reserve");
  const luna = getCatalogEntry("gpt-5.6-luna");
  assert.equal(reserve.source.tag, "rust-v0.164.0");
  assert.equal(reserve.source.model, "gpt-5.6-luna");
  assert.equal(reserve.adapter, "gpt-responses");
  const changed = Object.keys(luna.model).filter(key => JSON.stringify(reserve.model[key]) !== JSON.stringify(luna.model[key]));
  assert.deepEqual(changed, ["slug", "display_name", "description", "visibility", "upgrade", "priority"]);
  assert.deepEqual(Object.keys(reserve.model), Object.keys(luna.model));
  assert.equal(reserve.model.visibility, "hide");
  assert.equal(reserve.model.upgrade, null);

  const config = validateConfig({
    upstreams: { test: { base_url: "https://example.com/v1" } },
    models: { "gpt-reserve": { catalog: "gpt-reserve", upstream: "test", model: "gpt-reserve", visibility: "hide" } },
  });
  const [entry] = buildCatalog(config).models;
  assert.equal(entry.slug, "gpt-reserve");
  assert.equal(entry.visibility, "hide");
  assert.equal(entry.description, reserve.model.description);
  assert.equal(entry.upgrade, null);
  assert.equal(entry.multi_agent_version, "v1");
  assert.equal(entry.default_reasoning_level, "medium");
  const route = resolveModel(config, "gpt-reserve");
  assert.equal(route.profile.id, "gpt-responses");
  assert.equal(reasoningEffort(route), "medium");
});

test("GPT-5.5 preserves Lite declarations and Responses forwards explicit Daybreak access", () => {
  const config = validateConfig({
    upstreams: { test: { base_url: "https://example.com/v1" } },
    models: {
      legacy: { catalog: "gpt-5.5", upstream: "test", model: "legacy-deployment" },
      modern: { catalog: "gpt-6.1-sol", upstream: "test", model: "modern-deployment" },
    },
  });
  const tools = [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }];
  const body = responsesBody({
    route: resolveModel(config, "legacy"), signal: new AbortController().signal,
    request: { model: "legacy", input: [{ type: "additional_tools", tools }], parallel_tool_calls: false },
  });
  assert.equal(body.model, "legacy-deployment");
  assert.deepEqual(body.input, [{ type: "additional_tools", tools }]);
  assert.equal(body.tools, undefined);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.reasoning.effort, "medium");
  for (const cyber of ["daybreak_blue", "daybreak_red"]) {
    const body = responsesBody({
      route: resolveModel(config, "modern"), signal: new AbortController().signal,
      request: { model: "modern", input: "Hello", access_programs: { cyber } },
    });
    assert.deepEqual(body.access_programs, { cyber });
    assert.equal(body.model, "modern-deployment");
  }
});
