import { modelProfile } from "./profiles.ts";
import type { BridgeConfig } from "./types.ts";

/** Serve only configured aliases, using their own reviewed client behavior. */
export function buildCatalog(config: BridgeConfig): { models: Record<string, any>[] } {
  return { models: Object.entries(config.models).map(([slug, model], priority) => ({
    ...modelProfile(model).model_info,
    slug, display_name: slug, priority, visibility: "list", supported_in_api: true,
  })) };
}

export function configSnippet(config: BridgeConfig, catalogPath?: string): string {
  const host = ["0.0.0.0", "::"].includes(config.host ?? "") ? "127.0.0.1" : config.host ?? "127.0.0.1";
  const authority = host.includes(":") ? `[${host}]` : host;
  const baseUrl = `http://${authority}:${config.port ?? 8787}/v1`;
  const lines = [
    `model = ${JSON.stringify(Object.keys(config.models)[0])}`, 'model_provider = "bridge"',
    ...(catalogPath ? [`model_catalog_json = ${JSON.stringify(catalogPath)}`] : []),
    'web_search = "disabled"', "", "[features]", "image_generation = false", "",
    "[model_providers.bridge]", 'name = "Local bridge"',
    `base_url = ${JSON.stringify(baseUrl)}`, 'wire_api = "responses"',
  ];
  if (!catalogPath) lines.push(`model_catalog_url = ${JSON.stringify(`${baseUrl}/models`)}`);
  if (config.token_env) lines.push(`env_key = ${JSON.stringify(config.token_env)}`);
  // Codex requires API-key auth mode for provider catalog discovery, even on loopback.
  else if (!catalogPath) lines.push('experimental_bearer_token = "codeks-bridge-local"');
  lines.push("", "[model_providers.bridge.capabilities]", 'remote_compaction = "v2"', "");
  return lines.join("\n");
}
