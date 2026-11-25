import assert from "node:assert/strict";
import test from "node:test";
import { buildGeminiRequest } from "../src/backends/gemini.ts";
import { responsesBody } from "../src/backends/responses.ts";
import { buildCatalog } from "../src/catalog.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { catalogKeys, getCatalogEntry } from "../src/model-catalog.ts";
import { reasoningEffort } from "../src/profiles.ts";

test("GPT catalog entries record reviewed subscription or public source provenance", () => {
  const fallback = new Set<string>(["gpt-5.5", "gpt-daybreak-red-latest"]);
  for (const key of catalogKeys) {
    const entry = getCatalogEntry(key);
    if (entry.adapter !== "gpt-responses") continue;
    const { source } = entry;
    assert.equal(source.model, key);
    if (fallback.has(key)) {
      assert.ok("repository" in source, key);
      assert.equal(source.repository, "https://github.com/openai/codex");
      assert.match(source.tag, /^rust-v\d+\.\d+\.\d+$/);
      assert.match(source.commit, /^[0-9a-f]{40}$/);
      assert.equal(source.path, "codex-rs/models-manager/models.json");
    } else {
      assert.ok("endpoint" in source, key);
      assert.deepEqual(Object.keys(source).sort(), ["client_version", "endpoint", "model", "retrieved"]);
      assert.equal(source.endpoint, "https://chatgpt.com/backend-api/codex/models");
      assert.match(source.client_version, /^\d+\.\d+\.\d+$/);
      assert.match(source.retrieved, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(entry.model.shell_type, "unified_exec", key);
    }
  }
});

for (const [key, window, tiers] of [
  ["gpt-6.2-sol", 500000, ["priority", "ultrafast"]],
  ["gpt-6.2-astra", 272000, ["priority"]],
] as const) {
  test(`${key} preserves its subscription capabilities and routes Ultra to xhigh`, () => {
    const original = getCatalogEntry(key);
    const config = validateConfig({
      upstreams: { test: { base_url: "https://example.com/v1" } },
      models: { worker: { catalog: key, upstream: "test", model: `deployment/${key}` } },
    });
    const [entry] = buildCatalog(config).models;
    assert.equal(entry.context_window, window);
    assert.equal(entry.max_context_window, 872000);
    assert.equal(entry.auto_compact_token_limit, undefined);
    assert.equal(entry.supports_reasoning_effort_updates, true);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.deepEqual(entry.service_tiers.map((tier: { id: string }) => tier.id), tiers);
    assert.deepEqual(entry.model_messages, original.model.model_messages);
    assert.equal(entry.base_instructions, original.model.base_instructions);
    assert.deepEqual(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
    const route = resolveModel(config, "worker");
    assert.equal(route.compaction.mode, "native");
    const body = responsesBody({
      route, signal: new AbortController().signal,
      request: { model: "worker", input: "Hello", reasoning: { effort: "ultra" }, service_tier: tiers.at(-1) },
    });
    assert.equal(body.model, `deployment/${key}`);
    assert.equal(body.reasoning.effort, "xhigh");
    assert.equal(body.service_tier, tiers.at(-1));
    if (key === "gpt-6.2-sol") {
      config.models.worker!.input_modalities = ["text", "audio"];
      assert.deepEqual(buildCatalog(validateConfig(config)).models[0]!.input_modalities, ["text", "audio"]);
    }
  });
}

for (const [key, defaultEffort, ultra, levels] of [
  ["gemini-3.8-flash", "medium", "high", ["low", "medium", "high", "ultra"]],
  ["gemini-4-argon", "medium", "high", ["low", "medium", "high", "ultra"]],
  ["gemini-4-carbon", "medium", "high", ["low", "medium", "high", "ultra"]],
  ["gemini-4-hydrogen", "high", "xhigh", ["low", "medium", "high", "xhigh", "ultra"]],
  ["gemini-4-neon", "high", "xhigh", ["low", "medium", "high", "xhigh", "ultra"]],
] as const) {
  test(`${key} keeps the reviewed working budget and exposes native thinking levels`, () => {
    const template = getCatalogEntry("gpt-6.2-sol");
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
    assert.deepEqual(entry.service_tiers, []);
    assert.deepEqual(entry.additional_speed_tiers, []);
    assert.equal(entry.default_service_tier ?? null, null);
    assert.equal(entry.available_access_programs, undefined);
    assert.equal(entry.auto_compact_token_limit, template.model.auto_compact_token_limit);
    assert.deepEqual(getCatalogEntry(key).source, template.source);
    assert.deepEqual(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort), levels);
    const expectedMessages = structuredClone(template.model.model_messages);
    expectedMessages.instructions_template = expectedMessages.instructions_template.replace("based on GPT-6", "based on Gemini model");
    assert.deepEqual(entry.model_messages, expectedMessages);
    assert.match(entry.model_messages.instructions_template, /^You are Codex, an agent based on Gemini model\./);
    for (const level of entry.supported_reasoning_levels) {
      assert.deepEqual(level, template.model.supported_reasoning_levels.find((source: { effort: string }) => source.effort === level.effort));
    }
    const route = resolveModel(config, "gemini");
    assert.equal(route.profile.id, "gemini-native");
    assert.equal(route.profile.api, "gemini");
    assert.equal(route.profile.max_output_tokens, undefined);
    assert.equal(route.compaction.mode, "summary");
    assert.equal(reasoningEffort(route), defaultEffort);
    assert.equal(reasoningEffort(route, "ultra"), ultra);
    assert.equal(reasoningEffort(route, "minimal"), "minimal");
    const context = { route, request: { model: "gemini", input: "Hello" }, signal: new AbortController().signal };
    const defaults = buildGeminiRequest(context).body.generationConfig;
    assert.deepEqual(defaults.thinkingConfig, { thinkingLevel: defaultEffort.toUpperCase(), includeThoughts: false });
    assert.equal(defaults.maxOutputTokens, undefined);
    const { generationConfig } = buildGeminiRequest({
      ...context, request: { ...context.request, reasoning: { effort: "ultra", summary: "auto" }, max_output_tokens: 4096 },
    }).body;
    assert.deepEqual(generationConfig.thinkingConfig, { thinkingLevel: ultra.toUpperCase(), includeThoughts: true });
    assert.equal(generationConfig.maxOutputTokens, 4096);
  });
}

test("GPT-6.1 Terra keeps its reviewed window and resolves Ultra through xhigh", () => {
  const original = getCatalogEntry("gpt-6.1-terra");
  const config = validateConfig({
    upstreams: { test: { base_url: "https://example.com/v1" } },
    models: { terra: { catalog: "gpt-6.1-terra", upstream: "test", model: "terra-deployment" } },
  });
  const [entry] = buildCatalog(config).models;
  assert.equal(entry.context_window, 500000);
  assert.equal(entry.max_context_window, 872000);
  assert.equal(entry.shell_type, "unified_exec");
  assert.equal(entry.tool_mode, "code_mode_only");
  assert.equal(entry.multi_agent_version, "v2");
  assert.equal(entry.use_responses_lite, true);
  assert.deepEqual(entry.model_messages, original.model.model_messages);
  assert.equal(entry.auto_compact_token_limit, undefined);
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
    if (key === "gpt-5.5") assert.match(original.adjustments.join("\n"), /Responses Lite/);
    assert.equal(entry.shell_type, "endpoint" in original.source ? "unified_exec" : "shell_command");
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

test("GPT-Reserve keeps the subscription entry and routes as a hidden alias", () => {
  const reserve = getCatalogEntry("gpt-reserve");
  assert.equal(reserve.adapter, "gpt-responses");
  assert.equal(reserve.model.shell_type, "unified_exec");
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
