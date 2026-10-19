import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, resolveModel } from "../src/config.ts";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { upstreamHeaders } from "../src/auth.ts";
import { reasoningEffort } from "../src/profiles.ts";
import { getCatalogEntry } from "../src/model-catalog.ts";
import { buildAnthropicRequest } from "../src/backends/anthropic.ts";
import { buildDeepSeekRequest } from "../src/backends/deepseek.ts";

const config = () => validateConfig({
  upstreams: { a: { base_url: "https://example.com/v1" } },
  models: { first: { upstream: "a", catalog: "deepseek-flash", model: "deployment-a", context_window: 100000 } },
});

test("state provenance survives alias and policy changes but distinguishes actual targets", () => {
  const c = config();
  c.models.alias = { ...c.models.first };
  const before = resolveModel(c, "first").origin;
  c.models.alias.context_window = 256000;
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
  c.models.second.catalog = "gpt-6.1-sol";
  assert.throws(() => validateConfig(c), /cannot decode/);
  delete c.models.second.replay;
  c.models.first.compaction = { mode: "native" };
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
  const result = buildCatalog(c);
  const entry = result.models[0];
  assert.equal(entry.use_responses_lite, true);
  assert.equal(entry.multi_agent_version, "v2");
  assert.equal(entry.context_window, 100000);
  assert.deepEqual(entry.model_messages, getCatalogEntry("deepseek-flash").model.model_messages);
  assert.equal(entry.default_reasoning_level, "low");
  assert.deepEqual(entry.supported_reasoning_levels.map((p: any) => p.effort), ["low", "high"]);
  assert.deepEqual(entry.input_modalities, ["text"]);
  assert.match(configSnippet(c, "/tmp/catalog.json"), /remote_compaction = "v2"/);
});

test("compaction defaults follow the adapter's native representation", () => {
  const c = config();
  assert.deepEqual(resolveModel(c, "first").compaction, { mode: "summary", native_replay: false });
  c.models.first.catalog = "gpt-6.1-sol";
  assert.deepEqual(resolveModel(validateConfig(c), "first").compaction, { mode: "native", native_replay: true });
});

test("native compaction generation and replay are independently configured", () => {
  const c = config();
  c.models.first.catalog = "gpt-6.1-sol";
  c.models.first.compaction = { mode: "summary", native_replay: true };
  assert.deepEqual(resolveModel(validateConfig(c), "first").compaction, { mode: "summary", native_replay: true });
  c.models.first.compaction = { mode: "native", native_replay: false };
  assert.deepEqual(resolveModel(validateConfig(c), "first").compaction, { mode: "native", native_replay: false });
  c.models.first.catalog = "deepseek-flash";
  assert.throws(() => validateConfig(c), /native compaction representation/);
});

test("compaction cache directory is optional and validates explicit paths", () => {
  const c = config();
  assert.equal(c.compaction_cache_dir, undefined);
  c.compaction_cache_dir = "/tmp/synthetic-compaction-cache";
  assert.equal(validateConfig(c).compaction_cache_dir, c.compaction_cache_dir);
  c.compaction_cache_dir = "  ";
  assert.throws(() => validateConfig(c), /compaction_cache_dir/);
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
  const entry = buildCatalog(c).models[0];
  assert.equal(entry.multi_agent_reasoning_effort, "high");
  const route = resolveModel(c, "first");
  assert.equal(reasoningEffort(route, entry.multi_agent_reasoning_effort), reasoningEffort(route, "ultra"));
  c.models.first.reasoning.effort_map!.ultra = "unreachable-only-through-ultra";
  assert.throws(() => validateConfig(c), /ultra must map/);
});

test("curated GPT entries preserve each model's instructions and reasoning choices", () => {
  const keys = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"];
  const c = validateConfig({
    upstreams: { a: { base_url: "https://example.com/v1" } },
    models: Object.fromEntries(keys.map(key => [key, { catalog: key, upstream: "a", model: `deployment/${key}` }])),
  });
  const entries = buildCatalog(c).models;
  for (const entry of entries) {
    const curated = getCatalogEntry(entry.slug).model;
    assert.deepEqual(entry.model_messages, curated.model_messages);
    assert.deepEqual(entry.supported_reasoning_levels, curated.supported_reasoning_levels);
    assert.equal(entry.default_reasoning_level, curated.default_reasoning_level);
    assert.equal(entry.multi_agent_reasoning_effort, curated.multi_agent_reasoning_effort);
    assert.equal(entry.context_window, curated.context_window);
    assert.equal(entry.max_context_window, curated.max_context_window);
    assert.equal(entry.tool_mode, "code_mode_only");
    assert.equal(entry.use_responses_lite, true);
    const route = resolveModel(c, entry.slug);
    assert.equal(reasoningEffort(route), entry.default_reasoning_level);
    assert.equal(route.profile.id, "gpt-responses");
  }
  const sol = entries.find(entry => entry.slug === "gpt-6.1-sol")!;
  const luna = entries.find(entry => entry.slug === "gpt-6-luna")!;
  const previous = entries.find(entry => entry.slug === "gpt-5.6-sol")!;
  assert.equal(sol.default_reasoning_level, "low");
  assert.equal(luna.default_reasoning_level, "medium");
  assert(sol.supported_reasoning_levels.some((level: any) => level.effort === "ultra"));
  assert(!luna.supported_reasoning_levels.some((level: any) => level.effort === "ultra"));
  assert.notDeepEqual(sol.model_messages, previous.model_messages);
  assert.equal(reasoningEffort(resolveModel(c, "gpt-6.1-sol"), "ultra"), "xhigh");
  assert.equal(reasoningEffort(resolveModel(c, "gpt-6-sol"), "ultra"), "max");
});

test("catalog keys select reviewed models while deployments and window aliases remain configurable", () => {
  const c = validateConfig({
    upstreams: { a: { base_url: "https://example.com/v1" } },
    models: {
      large: { catalog: "claude-opus-5-5", upstream: "a", model: "vendor/custom-deployment-v3" },
      small: { catalog: "claude-opus-5-5", upstream: "a", model: "vendor/custom-deployment-v3", context_window: 256000 },
    },
  });
  assert.equal(resolveModel(c, "large").profile.id, "claude-messages");
  assert.equal(resolveModel(c, "large").config.model, "vendor/custom-deployment-v3");
  assert.deepEqual(resolveModel(c, "large").origin, resolveModel(c, "small").origin);
  const [large, small] = buildCatalog(c).models;
  assert.equal(large.context_window, getCatalogEntry("claude-opus-5-5").model.context_window);
  assert.equal(small.context_window, 256000);
  assert.equal(small.max_context_window, 256000);
  assert.deepEqual(large.model_messages, small.model_messages);
  assert.equal(large.default_reasoning_summary, "none");
  assert.equal(small.slug, "small");
  assert(!JSON.stringify(buildCatalog(c)).includes("vendor/custom-deployment-v3"));
  c.models.large.catalog = "unknown-model";
  assert.throws(() => validateConfig(c), /catalog.*unknown-model|unknown.*catalog/i);
  c.models.large.catalog = "toString";
  assert.throws(() => validateConfig(c), /catalog.*toString|unknown.*catalog/i);
  delete (c.models.large as any).catalog;
  assert.throws(() => validateConfig(c), /catalog/i);
});

test("generated catalogs do not mutate the reviewed entries or other aliases", () => {
  const c = config();
  c.models.second = { ...c.models.first, context_window: 256000 };
  const original = structuredClone(getCatalogEntry("deepseek-flash"));
  const first = buildCatalog(c);
  const secondInstructions = structuredClone(first.models[1].model_messages);
  first.models[0].model_messages.instructions_template = "Synthetic modified instruction.";
  first.models[0].supported_reasoning_levels.length = 0;
  assert.deepEqual(first.models[1].model_messages, secondInstructions);
  assert.deepEqual(getCatalogEntry("deepseek-flash"), original);
  assert.deepEqual(buildCatalog(c).models[0].model_messages, original.model.model_messages);
});

test("client snippets use the HTTP catalog by default and permit a static catalog", () => {
  const c = config();
  c.host = "::";
  c.port = 9000;
  c.token_env = "SYNTHETIC_BRIDGE_TOKEN";
  const remote = configSnippet(c);
  assert.match(remote, /model_catalog_url = "http:\/\/\[::1\]:9000\/v1\/models"|model_catalog_url = "http:\/\/127\.0\.0\.1:9000\/v1\/models"/);
  assert.doesNotMatch(remote, /model_catalog_json/);
  assert.match(remote, /env_key = "SYNTHETIC_BRIDGE_TOKEN"/);
  assert.match(remote, /remote_compaction = "v2"/);
  assert.match(remote, /web_search = "disabled"/);
  assert.match(remote, /\n\[features\.multi_agent_v2\]\ntool_namespace = "agents"\n\n/);
  const local = configSnippet(c, "/tmp/catalog.json");
  assert.match(local, /model_catalog_json = "\/tmp\/catalog.json"/);
  assert.doesNotMatch(local, /model_catalog_url/);
});

test("third-party defaults retain the Codex role and provide model-specific Ultra and budgets", () => {
  const template = getCatalogEntry("gpt-6.1-sol").model;
  for (const [key, vendor, ultra, output] of [
    ["claude-opus-5-5", "Claude", "xhigh", 128000],
    ["claude-sonnet-5-5", "Claude", "max", 128000],
    ["deepseek-flash", "DeepSeek", "max", undefined],
  ] as const) {
    const c = validateConfig({ upstreams: { a: { base_url: "https://example.com/v1" } }, models: {
      selected: { catalog: key, upstream: "a", model: "deployment" },
    } });
    const info = buildCatalog(c).models[0];
    const expectedMessages = structuredClone(template.model_messages);
    expectedMessages.instructions_template = expectedMessages.instructions_template.replace("based on GPT-6", `based on ${vendor}`);
    assert.deepEqual(info.model_messages, expectedMessages);
    assert.equal(info.default_reasoning_summary, template.default_reasoning_summary);
    assert.equal(info.context_window, 1000000);
    assert.equal(info.max_context_window, 1000000);
    assert.equal(info.multi_agent_reasoning_effort, ultra);
    assert(info.supported_reasoning_levels.some((level: any) => level.effort === "ultra"));
    const route = resolveModel(c, "selected");
    assert.equal(reasoningEffort(route, "ultra"), ultra);
    const build = key === "deepseek-flash" ? buildDeepSeekRequest : buildAnthropicRequest;
    const ctx = { route, request: { model: "selected", input: "Hello" }, signal: new AbortController().signal };
    assert.equal(build(ctx).body.max_tokens, output);
    c.models.selected.max_output_tokens = 8192;
    ctx.route = resolveModel(c, "selected");
    assert.equal(build(ctx).body.max_tokens, 8192);
    assert.equal(build({ ...ctx, request: { ...ctx.request, max_output_tokens: 2048 } }).body.max_tokens, 2048);
    // Endpoint capabilities remain the upstream's decision, not a local hard cap.
    assert.equal(build({ ...ctx, request: { ...ctx.request, max_output_tokens: 500000 } }).body.max_tokens, 500000);
  }
});

test("Claude 5.5 catalogs offer thinking efforts and permit an explicit Sonnet native mode", () => {
  const c = validateConfig({
    upstreams: { anthropic: { base_url: "https://example.com/v1" } },
    models: {
      opus: { upstream: "anthropic", catalog: "claude-opus-5-5", model: "opus-deployment" },
      sonnet: { upstream: "anthropic", catalog: "claude-sonnet-5-5", model: "sonnet-deployment", options: {
        thinking: { type: "between_tools" }, output_config: { effort: "low" },
      } },
    },
  });
  for (const entry of buildCatalog(c).models) {
    assert.deepEqual(entry.supported_reasoning_levels.map((level: any) => level.effort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.equal(entry.default_reasoning_level, "medium");
  }
  const route = resolveModel(c, "sonnet");
  const { body } = buildAnthropicRequest({
    route, request: { model: "sonnet", input: "Hello", reasoning: { effort: "max", summary: "auto" } },
    signal: new AbortController().signal,
  });
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.deepEqual(body.output_config, { effort: "low" });
});
