import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, resolveModel, resolveCompactionModel } from "../src/config.ts";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { upstreamHeaders } from "../src/auth.ts";
import { reasoningEffort } from "../src/profiles.ts";
import { getCatalogEntry } from "../src/model-catalog.ts";
import { buildAnthropicRequest } from "../src/backends/anthropic.ts";
import { buildDeepSeekRequest } from "../src/backends/deepseek.ts";
import { resolveClaudeOptions } from "../src/adapter-options.ts";

const config = () => validateConfig({
  upstreams: { a: { base_url: "https://example.com/v1" } },
  models: { first: { upstream: "a", catalog: "deepseek-flash", model: "deployment-a", context_window: 100000 } },
});

test("request body limits accept omitted or positive MiB values and reject unsafe byte counts", () => {
  assert.equal(config().request_max_mib, undefined);
  for (const limit of [1, 64, 128]) {
    assert.equal(validateConfig({ ...config(), request_max_mib: limit }).request_max_mib, limit);
  }
  for (const limit of [null, "64", 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2 ** 33]) {
    assert.throws(() => validateConfig({ ...config(), request_max_mib: limit }), /request_max_mib/);
  }
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

test("adapter settings resolve from model, connection, and adapter defaults", () => {
  const c = config();
  c.models.first.catalog = "claude-sonnet-5-5";
  assert.deepEqual(resolveClaudeOptions(resolveModel(c, "first")), {
    thinking_mismatch: "drop_block",
  });
  c.upstreams.a.adapters = { "claude-messages": { thinking_mismatch: "error" } };
  assert.deepEqual(resolveClaudeOptions(resolveModel(validateConfig(c), "first")), {
    thinking_mismatch: "error",
  });
  c.models.first.adapters = { "claude-messages": { thinking_mismatch: "upstream_default" } };
  assert.deepEqual(resolveClaudeOptions(resolveModel(validateConfig(c), "first")), {
    thinking_mismatch: "upstream_default",
  });
});

test("adapter behavior does not alter state identity, catalog, or native request options", () => {
  const c = config();
  c.models.first.catalog = "claude-sonnet-5-5";
  const beforeOrigin = resolveModel(c, "first").origin;
  const beforeCatalog = buildCatalog(c);
  c.upstreams.a.options = { future_parameter: { enabled: true } };
  c.models.first.options = { another_parameter: 12 };
  c.upstreams.a.adapters = { "claude-messages": { thinking_mismatch: "error" } };
  c.models.first.adapters = { "claude-messages": { thinking_mismatch: "upstream_default" } };
  validateConfig(c);
  assert.deepEqual(resolveModel(c, "first").origin, beforeOrigin);
  assert.deepEqual(buildCatalog(c), beforeCatalog);
  assert.deepEqual(c.upstreams.a.options, { future_parameter: { enabled: true } });
  assert.deepEqual(c.models.first.options, { another_parameter: 12 });
  assert(!Object.hasOwn(c.models.first.options, "adapters"));
});

test("adapter settings reject misspelled keys and invalid values at either configuration scope", () => {
  for (const scope of ["upstreams", "models"] as const) {
    for (const [value, expected] of [
      [null, /adapters: must be an object/],
      [[], /adapters: must be an object/],
      [{ "claude-message": {} }, /unknown adapter settings claude-message/],
      [{ "gpt-responses": {} }, /unknown adapter settings gpt-responses/],
      [{ "claude-messages": null }, /claude-messages must be an object/],
      [{ "claude-messages": { thinking_mismtach: "drop_block" } }, /unknown claude-messages setting thinking_mismtach/],
      [{ "claude-messages": { thinking_mismatch: "ignore" } }, /thinking_mismatch must be drop_block, error, or upstream_default/],
      [{ "claude-messages": { thinking_mismatch: null } }, /thinking_mismatch must be drop_block, error, or upstream_default/],
    ] as const) {
      const c = config();
      c.models.first.catalog = "claude-sonnet-5-5";
      const target = scope === "upstreams" ? c.upstreams.a : c.models.first;
      Object.assign(target, { adapters: value });
      assert.throws(() => validateConfig(c), expected);
    }
  }
});

test("shared connections can configure one adapter without applying it to other model protocols", () => {
  const c = config();
  c.upstreams.a.adapters = { "claude-messages": { thinking_mismatch: "error" } };
  c.models.claude = { upstream: "a", catalog: "claude-sonnet-5-5", model: "claude-deployment" };
  assert.equal(validateConfig(c), c);
  assert.equal(resolveClaudeOptions(resolveModel(c, "claude")).thinking_mismatch, "error");
  assert.equal(resolveModel(c, "first").profile.id, "deepseek-chat");
  c.models.first.adapters = { "claude-messages": { thinking_mismatch: "drop_block" } };
  assert.throws(() => validateConfig(c), /claude-messages does not match the model adapter deepseek-chat/);
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

test("model exposure controls discovery and snippet defaults without changing state identity", () => {
  const c = config();
  const original = resolveModel(c, "first").origin;
  c.models.second = { ...c.models.first, expose: true };
  c.models.third = { ...c.models.first };
  c.models.first.expose = false;
  validateConfig(c);
  assert.deepEqual(buildCatalog(c).models.map(({ slug, priority }) => [slug, priority]), [["second", 0], ["third", 1]]);
  for (const catalog of [undefined, "/tmp/catalog.json"]) {
    assert.match(configSnippet(c, catalog), /^model = "second"\n/);
  }
  assert.deepEqual(resolveModel(c, "first").origin, original);
  c.models.second.expose = c.models.third.expose = false;
  validateConfig(c);
  assert.deepEqual(buildCatalog(c), { models: [] });
  assert.throws(() => configSnippet(c), /at least one model with expose enabled/);
  for (const value of ["false", 0, null]) {
    c.models.first.expose = value as unknown as boolean;
    assert.throws(() => validateConfig(c), /expose must be boolean/);
  }
});

test("picker visibility retains full metadata and routing while snippets select a listed model", () => {
  const c = config();
  const original = buildCatalog(c).models[0];
  const route = resolveModel(c, "first");
  c.models.first.visibility = "hide";
  c.models.second = { ...c.models.first, visibility: "list" };
  c.models.third = { ...c.models.first, visibility: undefined };
  validateConfig(c);
  const entries = buildCatalog(c).models;
  assert.deepEqual(entries[0], { ...original, visibility: "hide" });
  assert.deepEqual(entries.map(({ slug, visibility }) => [slug, visibility]), [
    ["first", "hide"], ["second", "list"], ["third", "list"],
  ]);
  assert.deepEqual(resolveModel(c, "first").origin, route.origin);
  assert.deepEqual(resolveModel(c, "first").profile, route.profile);
  for (const catalog of [undefined, "/tmp/catalog.json"]) {
    assert.match(configSnippet(c, catalog), /^model = "second"\n/);
  }
  c.models.second.expose = false;
  assert.match(configSnippet(c), /^model = "third"\n/);
  c.models.third.visibility = "hide";
  validateConfig(c);
  assert.equal(buildCatalog(c).models.length, 2);
  assert.throws(() => configSnippet(c), /expose enabled and visibility list/);
  for (const value of ["hidden", "", true, null]) {
    c.models.first.visibility = value as any;
    assert.throws(() => validateConfig(c), /visibility must be list or hide/);
  }
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

test("delegated generation keeps the caller's mode and the executor's replay policy", () => {
  const c = config();
  c.models.executor = { upstream: "a", catalog: "gpt-6.1-sol", model: "deployment-b",
    compaction: { mode: "summary", model: "first" } };
  c.models.first.compaction = { model: "executor" };
  validateConfig(c);
  const caller = resolveModel(c, "first");
  assert.equal(resolveCompactionModel(c, caller).compaction.mode, "summary");
  c.models.first.compaction.mode = "native";
  validateConfig(c);
  const nativeCaller = resolveModel(c, "first");
  const executor = resolveCompactionModel(c, nativeCaller);
  assert.equal(executor.slug, "executor");
  assert.equal(executor.compaction.mode, "native");
  assert.equal(executor.compaction.native_replay, true);
  assert.equal(nativeCaller.compaction.native_replay, false);
  assert(executor.replay.native_compaction.has(executor.origin.id));
  assert(!executor.replay.native_compaction.has(nativeCaller.origin.id));
  assert.equal(resolveModel(c, "executor").compaction.mode, "summary");
  assert.deepEqual(resolveModel(c, "first").origin, caller.origin);
  // Generation is single-hop, including when the configured references form a cycle.
  assert.equal(resolveCompactionModel(c, resolveModel(c, "executor")).slug, "first");
  c.models.first.compaction.native_replay = true;
  assert.throws(() => validateConfig(c), /native compaction representation for replay/);
});

test("delegation validates aliases and the selected generator's representation", () => {
  const c = config();
  for (const model of ["", "missing", "toString", null, 42]) {
    c.models.first.compaction = { model: model as string };
    assert.throws(() => validateConfig(c), /compaction.model must name an existing model alias/);
  }
  c.models.first.compaction = { model: "first" };
  const caller = resolveModel(validateConfig(c), "first");
  assert.equal(resolveCompactionModel(c, caller), caller);
  c.models.gpt = { upstream: "a", catalog: "gpt-6.1-sol", model: "deployment-b",
    compaction: { model: "first" } };
  assert.throws(() => validateConfig(c), /compaction model first has no native compaction representation/);
  c.models.gpt.compaction!.mode = "summary";
  validateConfig(c);
  c.models.gpt.replay = { reasoning_from: ["missing"] };
  assert.throws(() => validateConfig(c), /unknown replay source missing/);
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

test("Gemini credentials belong to the upstream and can use a Bearer token", async () => {
  const upstream = {
    base_url: "https://example.com/v1beta",
    api_key_command: [process.execPath, "-e", "process.stdout.write('synthetic-credential')"],
  };
  const signal = new AbortController().signal;
  const client = new Headers({ authorization: "Bearer bridge-credential", "x-goog-api-key": "client-key", "session-id": "synthetic-session" });
  const native = await upstreamHeaders(upstream, "gemini", signal, client);
  assert.equal(native.get("x-goog-api-key"), "synthetic-credential");
  assert.equal(native.get("authorization"), null);
  assert.equal(native.get("session-id"), "synthetic-session");
  const bearer = await upstreamHeaders({ ...upstream, auth_header: "authorization" }, "gemini", signal, client);
  assert.equal(bearer.get("authorization"), "Bearer synthetic-credential");
  assert.equal(bearer.get("x-goog-api-key"), null);
  const responses = await upstreamHeaders(upstream, "responses", signal, client);
  assert.equal(responses.get("x-goog-api-key"), null);
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
  const keys = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
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
    assert.equal(entry.shell_type, "unified_exec");
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
  const terra56 = entries.find(entry => entry.slug === "gpt-5.6-terra")!;
  const luna56 = entries.find(entry => entry.slug === "gpt-5.6-luna")!;
  assert.equal(terra56.multi_agent_version, "v2");
  assert.equal(luna56.multi_agent_version, "v1");
  assert.equal(terra56.default_reasoning_level, "medium");
  assert.equal(luna56.default_reasoning_level, "medium");
  assert.equal(reasoningEffort(resolveModel(c, "gpt-5.6-terra"), "ultra"), "max");
  assert(!luna56.supported_reasoning_levels.some((level: any) => level.effort === "ultra"));
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
  for (const [key, vendor, ultra, output, contextWindow] of [
    ["claude-opus-5-5", "Claude", "xhigh", 128000, 400000],
    ["claude-sonnet-5-5", "Claude", "max", 128000, 400000],
    ["claude-haiku-5-5", "Claude", "max", 128000, 400000],
    ["deepseek-flash", "DeepSeek", "max", undefined, 1000000],
  ] as const) {
    const c = validateConfig({ upstreams: { a: { base_url: "https://example.com/v1" } }, models: {
      selected: { catalog: key, upstream: "a", model: "deployment" },
    } });
    const info = buildCatalog(c).models[0];
    const expectedMessages = structuredClone(template.model_messages);
    expectedMessages.instructions_template = expectedMessages.instructions_template.replace("based on GPT-6", `based on ${vendor}`);
    assert.deepEqual(info.model_messages, expectedMessages);
    assert.equal(info.default_reasoning_summary, template.default_reasoning_summary);
    assert.equal(info.context_window, contextWindow);
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

test("Haiku 5.5 uses adaptive thinking and the shared Claude effort choices", () => {
  const c = validateConfig({
    upstreams: { anthropic: { base_url: "https://example.com/v1" } },
    models: { haiku: { upstream: "anthropic", catalog: "claude-haiku-5-5", model: "haiku-deployment" } },
  });
  const info = buildCatalog(c).models[0];
  assert.deepEqual(info.supported_reasoning_levels.map((level: any) => level.effort),
    ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(info.default_reasoning_level, "medium");
  assert.equal(info.multi_agent_version, "v2");
  assert.deepEqual(info.input_modalities, ["text", "image"]);
  const ctx = {
    route: resolveModel(c, "haiku"), request: { model: "haiku", input: "Hello" },
    signal: new AbortController().signal,
  };
  assert.equal(ctx.route.profile.id, "claude-messages");
  const { body } = buildAnthropicRequest(ctx);
  assert.equal(body.model, "haiku-deployment");
  assert.deepEqual(body.thinking, {
    type: "adaptive", display: "omitted", block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.equal(buildAnthropicRequest({ ...ctx, request: { ...ctx.request, reasoning: { summary: "auto" } } })
    .body.thinking.display, "summarized");
});

test("DeepSeek offers native effort choices while keeping request aliases compatible", () => {
  const c = config();
  const info = buildCatalog(c).models[0];
  assert.deepEqual(info.supported_reasoning_levels.map((level: any) => level.effort),
    ["none", "low", "high", "max", "ultra"]);
  assert.equal(info.default_reasoning_level, "high");
  assert.equal(info.multi_agent_reasoning_effort, "max");
  const ctx = {
    route: resolveModel(c, "first"), request: { model: "first", input: "Hello" },
    signal: new AbortController().signal,
  };
  for (const [effort, native] of [
    ["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"],
    ["xhigh", "high"], ["max", "max"], ["ultra", "max"],
  ]) {
    const { body } = buildDeepSeekRequest({ ...ctx, request: { ...ctx.request, reasoning: { effort } } });
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, native);
  }
  const { body } = buildDeepSeekRequest({ ...ctx, request: { ...ctx.request, reasoning: { effort: "none" } } });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
});
