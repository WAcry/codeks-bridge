import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveModel } from "./config.ts";
import type { BridgeConfig } from "./types.ts";
import { BridgeError } from "./errors.ts";
const execute = promisify(execFile);

/** Keep client-specific fields from its own bundled catalog instead of freezing a copy. */
export function buildCatalog(config: BridgeConfig, bundled: any, templateSlug?: string): { models: any[] } {
  if (!Array.isArray(bundled?.models)) throw new BridgeError("Bundled catalog must contain a models array");
  const template = templateSlug ? bundled.models.find((m: any) => m.slug === templateSlug)
    : bundled.models.find((m: any) => m.visibility === "list" && m.multi_agent_version === "v2") ?? bundled.models[0];
  if (!template) throw new BridgeError("Catalog template model was not found");
  return { models: Object.entries(config.models).map(([slug, model], index) => {
    if (!model.context_window) throw new BridgeError(`Set context_window for ${slug} before generating the catalog`);
    const { profile } = resolveModel(config, slug);
    const entry = structuredClone(template);
    Object.assign(entry, {
      slug, display_name: slug, description: `Configured model: ${slug}`, priority: index,
      visibility: "list", supported_in_api: true,
      context_window: model.context_window, max_context_window: model.context_window,
      default_reasoning_level: profile.default_effort,
      multi_agent_reasoning_effort: profile.multi_agent_effort ?? null,
      supported_reasoning_levels: Object.entries(profile.effort_map).map(([effort, native]) => ({ effort, description: `Upstream effort: ${native}` })),
      input_modalities: profile.input_modalities,
      use_responses_lite: false, supports_search_tool: false,
      support_verbosity: false, default_reasoning_summary: "auto",
      supports_reasoning_effort_updates: false, supports_image_detail_original: false,
      service_tiers: [], additional_speed_tiers: [], availability_nux: null, upgrade: null,
    });
    delete entry.default_service_tier;
    delete entry.model_specialty;
    // Catalogs are generated locally. Client instructions stay with the client.
    return entry;
  }) };
}
export async function readBundledCatalog(binary: string): Promise<unknown> {
  const { stdout } = await execute(binary, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export function configSnippet(config: BridgeConfig, catalogPath: string): string {
  const host = ["0.0.0.0", "::"].includes(config.host ?? "") ? "127.0.0.1" : config.host ?? "127.0.0.1";
  const authority = host.includes(":") ? `[${host}]` : host;
  const model = Object.keys(config.models)[0];
  const lines = [
    `model = ${JSON.stringify(model)}`, 'model_provider = "bridge"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`, 'web_search = "disabled"', "",
    "[model_providers.bridge]", 'name = "Local bridge"',
    `base_url = ${JSON.stringify(`http://${authority}:${config.port ?? 8787}/v1`)}`, 'wire_api = "responses"',
  ];
  if (config.token_env) lines.push(`env_key = ${JSON.stringify(config.token_env)}`);
  lines.push("", "[model_providers.bridge.capabilities]", 'remote_compaction = "v2"', "");
  return lines.join("\n");
}
