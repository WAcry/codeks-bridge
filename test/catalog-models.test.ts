import assert from "node:assert/strict";
import test from "node:test";
import { responsesBody } from "../src/backends/responses.ts";
import { buildCatalog } from "../src/catalog.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { catalogKeys, getCatalogEntry } from "../src/model-catalog.ts";
import { reasoningEffort } from "../src/profiles.ts";

for (const key of ["gemini-3.8-flash", "gemini-4-argon"]) {
  test(`${key} keeps the Codex working budget and exposes native thinking levels`, () => {
    const config = validateConfig({
      upstreams: { test: { base_url: "https://generativelanguage.googleapis.com/v1beta" } },
      models: { gemini: { catalog: key, upstream: "test", model: "gemini-deployment" } },
    });
    const [entry] = buildCatalog(config).models;
    assert.equal(entry.context_window, 272000);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal(entry.tool_mode, "code_mode_only");
    assert.equal(entry.multi_agent_version, "v2");
    assert.equal(entry.use_responses_lite, true);
    assert.equal(entry.shell_type, "unified_exec");
    assert.equal(entry.default_reasoning_summary, "none");
    assert.equal(entry.supports_image_detail_original, false);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.deepEqual(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort), ["low", "medium", "high", "ultra"]);
    assert.match(entry.model_messages.instructions_template, /You are Codex, an agent based on Gemini/);
    const route = resolveModel(config, "gemini");
    assert.equal(route.profile.id, "gemini-native");
    assert.equal(route.profile.api, "gemini");
    assert.equal(route.profile.max_output_tokens, undefined);
    assert.equal(route.compaction.mode, "summary");
    assert.equal(reasoningEffort(route), "medium");
    assert.equal(reasoningEffort(route, "ultra"), "high");
    assert.equal(reasoningEffort(route, "minimal"), "minimal");
  });
}

test("GPT-6.1 Terra keeps its reviewed window and resolves Ultra through xhigh", () => {
  const original = getCatalogEntry("gpt-6.1-terra");
  const config = validateConfig({
    upstreams: { test: { base_url: "https://example.com/v1" } },
    models: { terra: { catalog: "gpt-6.1-terra", upstream: "test", model: "terra-deployment" } },
  });
  const [entry] = buildCatalog(config).models;
  assert.equal(entry.context_window, 272000);
  assert.equal(entry.max_context_window, 872000);
  assert.equal(entry.shell_type, "unified_exec");
  assert.equal(entry.tool_mode, "code_mode_only");
  assert.equal(entry.multi_agent_version, "v2");
  assert.equal(entry.use_responses_lite, true);
  assert.deepEqual(entry.model_messages, original.model.model_messages);
  assert.equal(entry.auto_compact_token_limit, null);
  assert.equal(entry.default_reasoning_summary, "none");
  assert.equal(entry.supports_image_detail_original, true);
  const route = resolveModel(config, "terra");
  assert.equal(reasoningEffort(route), "low");
  assert.equal(reasoningEffort(route, "ultra"), "xhigh");
});

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
    assert.equal("tag" in original.source && original.source.tag, "rust-v0.164.0");
    if (key === "gpt-5.5") assert.match(original.adjustments[0], /Responses Lite/);
    assert.ok(original.adjustments.some(note => note.includes("shell_type")));
    assert.equal(entry.shell_type, "unified_exec");
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

test("GPT-Reserve keeps the subscription entry without names absent from public sources", () => {
  const reserve = getCatalogEntry("gpt-reserve");
  const luna = getCatalogEntry("gpt-5.6-luna");
  assert.deepEqual(reserve.source, {
    endpoint: "https://chatgpt.com/backend-api/codex/models", client_version: "0.164.0", retrieved: "2026-10-25", model: "gpt-reserve",
  });
  assert.equal(reserve.adapter, "gpt-responses");
  assert.equal(reserve.model.shell_type, "unified_exec");
  const subscriptionOnly = Object.keys(reserve.model).filter(key => !Object.hasOwn(luna.model, key));
  assert.deepEqual(subscriptionOnly, ["base_instructions", "available_access_programs"]);
  const publicPlans = new Set(catalogKeys.map(getCatalogEntry).filter(entry => "tag" in entry.source)
    .flatMap(entry => entry.model.available_in_plans ?? []));
  assert.deepEqual(reserve.model.available_in_plans.filter((plan: string) => !publicPlans.has(plan)), []);
  for (const key of ["context_window", "max_context_window", "comp_hash", "multi_agent_version", "supported_reasoning_levels"]) {
    assert.deepEqual(reserve.model[key], luna.model[key], key);
  }
  assert.equal(reserve.model.model_messages.instructions_template, luna.model.model_messages.instructions_template);
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
