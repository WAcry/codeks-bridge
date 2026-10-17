import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BridgeConfig, ResolvedModel } from "./types.ts";
import { BridgeError } from "./errors.ts";

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never { throw new BridgeError(`Invalid configuration: ${message}`); }
export function validateConfig(value: unknown): BridgeConfig {
  if (!object(value) || !object(value.upstreams) || !object(value.models)) fail("upstreams and models must be objects");
  if (!Object.keys(value.models).length) fail("at least one model is required");
  if (value.host !== undefined && (typeof value.host !== "string" || !value.host)) fail("host must be a string");
  if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535)) fail("port must be 0..65535");
  if (value.token_env !== undefined && (typeof value.token_env !== "string" || !value.token_env)) fail("token_env must name an environment variable");
  for (const [name, up] of Object.entries(value.upstreams)) {
    if (!object(up) || !["responses", "anthropic", "chat"].includes(up.api)) fail(`upstream ${name}: unknown api`);
    let url: URL;
    try { url = new URL(up.base_url); } catch { fail(`upstream ${name}: invalid base_url`); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(`upstream ${name}: base_url must be an HTTP(S) URL without credentials, query, or fragment`);
    if (up.api_key_env !== undefined && (typeof up.api_key_env !== "string" || !up.api_key_env)) fail(`upstream ${name}: invalid api_key_env`);
    if (up.api_key_env && up.api_key_command) fail(`upstream ${name}: choose api_key_env or api_key_command`);
    if (up.api_key_command !== undefined && (!Array.isArray(up.api_key_command) || !up.api_key_command.length || up.api_key_command.some((s: unknown) => typeof s !== "string"))) fail(`upstream ${name}: api_key_command must be a nonempty argv array`);
    if (up.stream_idle_timeout_ms !== undefined && (!Number.isSafeInteger(up.stream_idle_timeout_ms) || up.stream_idle_timeout_ms <= 0)) fail(`upstream ${name}: stream_idle_timeout_ms must be a positive integer`);
    if (up.auth_header !== undefined && (typeof up.auth_header !== "string" || !/^[\w-]+$/.test(up.auth_header))) fail(`upstream ${name}: invalid auth_header`);
    if (up.headers !== undefined && (!object(up.headers) || Object.values(up.headers).some(v => typeof v !== "string" || /[\r\n]/.test(v)))) fail(`upstream ${name}: invalid headers`);
    if (up.options !== undefined && !object(up.options)) fail(`upstream ${name}: options must be an object`);
  }
  for (const [slug, model] of Object.entries(value.models)) {
    if (!slug || !object(model) || typeof model.model !== "string" || !model.model || !Object.hasOwn(value.upstreams, model.upstream)) fail(`model ${slug}: model and an existing upstream are required`);
    for (const field of ["context_window", "max_output_tokens"]) {
      if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || model[field] <= 0)) fail(`model ${slug}: ${field} must be a positive integer`);
    }
    if (model.options !== undefined && !object(model.options)) fail(`model ${slug}: options must be an object`);
  }
  return value as BridgeConfig;
}
export async function loadConfig(path: string): Promise<BridgeConfig> {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
export function resolveModel(config: BridgeConfig, slug: string): ResolvedModel {
  if (typeof slug !== "string" || !Object.hasOwn(config.models, slug)) throw new BridgeError("Unknown model. Use GET /v1/models to list configured models.");
  const model = config.models[slug];
  const upstream = config.upstreams[model.upstream];
  // No endpoint or credential is copied into portable history envelopes.
  const key = createHash("sha256").update(JSON.stringify([model.upstream, upstream.api, upstream.base_url.replace(/\/+$/, ""), model.model])).digest("hex");
  return { slug, config: model, upstream, key };
}
