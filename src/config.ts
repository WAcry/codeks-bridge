import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { modelProfile } from "./profiles.ts";
import { getCatalogEntry } from "./model-catalog.ts";
import type { BridgeConfig, ModelConfig, ResolvedModel, StateOrigin } from "./types.ts";
import { BridgeError } from "./errors.ts";
import { validateAdapterConfig } from "./adapter-options.ts";

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never { throw new BridgeError(`Invalid configuration: ${message}`); }
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string" && v.length > 0);
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Record provenance, never policy or credentials, in portable history. */
function origin(config: BridgeConfig, model: ModelConfig): StateOrigin {
  const connection = hash([model.upstream, config.upstreams[model.upstream].base_url.replace(/\/+$/, "")]);
  const { adapter } = getCatalogEntry(model.catalog);
  return { connection, model: model.model, adapter, id: hash([connection, adapter, model.model]) };
}

export function validateConfig(value: unknown): BridgeConfig {
  if (!object(value) || !object(value.upstreams) || !object(value.models)) fail("upstreams and models must be objects");
  if (!Object.keys(value.models).length) fail("at least one model is required");
  if (value.host !== undefined && (typeof value.host !== "string" || !value.host)) fail("host must be a string");
  if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535)) fail("port must be 0..65535");
  if (value.token_env !== undefined && (typeof value.token_env !== "string" || !value.token_env)) fail("token_env must name an environment variable");
  if (value.request_max_mib !== undefined && (!Number.isSafeInteger(value.request_max_mib) || value.request_max_mib <= 0 || !Number.isSafeInteger(value.request_max_mib * 1024 * 1024))) fail("request_max_mib must be a positive integer with a safe byte count");
  if (value.compaction_cache_dir !== undefined && (typeof value.compaction_cache_dir !== "string" || !value.compaction_cache_dir.trim())) fail("compaction_cache_dir must be a nonempty path");
  if (value.inspect !== undefined) {
    const inspect = value.inspect;
    if (!object(inspect)) fail("inspect must be an object");
    if (inspect.capture !== undefined && typeof inspect.capture !== "boolean") fail("inspect.capture must be boolean");
    if (inspect.max_mib !== undefined && (!Number.isSafeInteger(inspect.max_mib) || inspect.max_mib <= 0)) fail("inspect.max_mib must be a positive integer");
  }
  for (const [name, up] of Object.entries(value.upstreams)) {
    if (!object(up)) fail(`upstream ${name}: expected a connection object`);
    let url: URL;
    try { url = new URL(up.base_url); } catch { fail(`upstream ${name}: invalid base_url`); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(`upstream ${name}: base_url must be an HTTP(S) URL without credentials, query, or fragment`);
    if (up.api_key_env !== undefined && (typeof up.api_key_env !== "string" || !up.api_key_env)) fail(`upstream ${name}: invalid api_key_env`);
    if (up.api_key_env && up.api_key_command) fail(`upstream ${name}: choose api_key_env or api_key_command`);
    if (up.api_key_command !== undefined && (!Array.isArray(up.api_key_command) || !up.api_key_command.length || up.api_key_command.some((arg: unknown) => typeof arg !== "string"))) fail(`upstream ${name}: api_key_command must be a nonempty argv array`);
    if (up.stream_idle_timeout_ms !== undefined && (!Number.isSafeInteger(up.stream_idle_timeout_ms) || up.stream_idle_timeout_ms <= 0)) fail(`upstream ${name}: invalid stream_idle_timeout_ms`);
    if (up.auth_header !== undefined && (typeof up.auth_header !== "string" || !/^[\w-]+$/.test(up.auth_header))) fail(`upstream ${name}: invalid auth_header`);
    if (up.headers !== undefined && (!object(up.headers) || Object.values(up.headers).some(v => typeof v !== "string" || /[\r\n]/.test(v)))) fail(`upstream ${name}: invalid headers`);
    if (up.options !== undefined && !object(up.options)) fail(`upstream ${name}: options must be an object`);
    validateAdapterConfig(up.adapters, `upstream ${name}`);
  }
  for (const [slug, model] of Object.entries(value.models)) {
    if (!slug || !object(model) || typeof model.model !== "string" || !model.model || typeof model.upstream !== "string" || !Object.hasOwn(value.upstreams, model.upstream)) fail(`model ${slug}: model and an existing upstream are required`);
    if (typeof model.catalog !== "string" || !model.catalog) fail(`model ${slug}: catalog is required`);
    if (model.expose !== undefined && typeof model.expose !== "boolean") fail(`model ${slug}: expose must be boolean`);
    for (const field of ["context_window", "max_output_tokens"]) {
      if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || model[field] <= 0)) fail(`model ${slug}: ${field} must be a positive integer`);
    }
    if (model.options !== undefined && !object(model.options)) fail(`model ${slug}: options must be an object`);
    if (model.input_modalities !== undefined && (!strings(model.input_modalities) || !model.input_modalities.length || model.input_modalities.some((m: string) => !["text", "image"].includes(m)))) fail(`model ${slug}: input_modalities must contain text or image`);
    if (model.reasoning !== undefined) {
      const r = model.reasoning;
      if (!object(r)) fail(`model ${slug}: reasoning must be an object`);
      if (r.default_effort !== undefined && (typeof r.default_effort !== "string" || !r.default_effort)) fail(`model ${slug}: invalid default_effort`);
      if (r.effort_map !== undefined && (!object(r.effort_map) || !Object.keys(r.effort_map).length || Object.entries(r.effort_map).some(([key, native]) => !key || typeof native !== "string" || !native))) fail(`model ${slug}: effort_map must map effort names to upstream values`);
    }
    const profile = modelProfile(model as ModelConfig);
    validateAdapterConfig(model.adapters, `model ${slug}`, profile.id);
    if (Object.hasOwn(profile.effort_map, "ultra") && !profile.multi_agent_effort) fail(`model ${slug}: ultra must map to the same upstream effort as an ordinary level`);
    if (!Object.hasOwn(profile.effort_map, profile.default_effort)) fail(`model ${slug}: default_effort must appear in effort_map`);
    if (model.replay !== undefined) {
      if (!object(model.replay)) fail(`model ${slug}: replay must be an object`);
      for (const field of ["reasoning_from", "native_compaction_from"]) {
        if (model.replay[field] !== undefined && !strings(model.replay[field])) fail(`model ${slug}: ${field} must list source model aliases`);
      }
    }
    if (model.compaction !== undefined) {
      const c = model.compaction;
      if (!object(c)) fail(`model ${slug}: compaction must be an object`);
      if (c.mode !== undefined && !["summary", "native"].includes(c.mode)) fail(`model ${slug}: compaction.mode must be summary or native`);
      if (c.model !== undefined && (typeof c.model !== "string" || !Object.hasOwn(value.models, c.model))) fail(`model ${slug}: compaction.model must name an existing model alias`);
      if (c.native_replay !== undefined && typeof c.native_replay !== "boolean") fail(`model ${slug}: compaction.native_replay must be boolean`);
      if (!profile.native_compaction_format && c.native_replay === true) fail(`model ${slug}: adapter has no native compaction representation for replay`);
    }
  }
  // References are directional. Validate decodability, not provider compatibility.
  const config = value as BridgeConfig;
  for (const [slug, model] of Object.entries(config.models)) {
    const target = modelProfile(model);
    for (const [field, format] of [["reasoning_from", "reasoning_format"], ["native_compaction_from", "native_compaction_format"]] as const) {
      for (const name of model.replay?.[field] ?? []) {
        if (!Object.hasOwn(config.models, name)) fail(`model ${slug}: unknown replay source ${name}`);
        const source = modelProfile(config.models[name]);
        if (!target[format] || source[format] !== target[format]) fail(`model ${slug}: cannot decode ${field} source ${name}`);
      }
    }
  }
  for (const slug of Object.keys(config.models)) {
    const executor = resolveCompactionModel(config, resolveModel(config, slug));
    if (executor.compaction.mode === "native" && !executor.profile.native_compaction_format) fail(`model ${slug}: compaction model ${executor.slug} has no native compaction representation`);
  }
  return config;
}
export async function loadConfig(path: string): Promise<BridgeConfig> {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
export function resolveModel(config: BridgeConfig, slug: string): ResolvedModel {
  if (typeof slug !== "string" || !Object.hasOwn(config.models, slug)) throw new BridgeError("Unknown model. Use GET /v1/models to list exposed models.");
  const model = config.models[slug];
  const profile = modelProfile(model);
  const source = origin(config, model);
  const allowed = (names: string[] = []) => new Set([source.id, ...names.map(name => origin(config, config.models[name]).id)]);
  return {
    slug, config: model, upstream: config.upstreams[model.upstream], profile, origin: source,
    replay: { reasoning: allowed(model.replay?.reasoning_from), native_compaction: allowed(model.replay?.native_compaction_from) },
    compaction: {
      mode: model.compaction?.mode ?? (profile.native_compaction_format ? "native" : "summary"),
      native_replay: model.compaction?.native_replay ?? !!profile.native_compaction_format,
    },
  };
}

/** Select one executor; the caller owns the generation mode, the executor owns replay. */
export function resolveCompactionModel(config: BridgeConfig, caller: ResolvedModel): ResolvedModel {
  const slug = caller.config.compaction?.model;
  if (slug === undefined || slug === caller.slug) return caller;
  const executor = resolveModel(config, slug);
  return { ...executor, compaction: { ...executor.compaction, mode: caller.compaction.mode } };
}
