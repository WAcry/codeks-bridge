import { getCatalogEntry } from "./model-catalog.ts";
import type { AdapterId, ModelConfig, ModelProfile, ResolvedModel } from "./types.ts";

/** Protocol representations belong to adapters; model defaults belong to the catalog. */
const FORMATS: Record<AdapterId, Pick<ModelProfile, "id" | "api" | "reasoning_format" | "native_compaction_format">> = {
  "gpt-responses": {
    id: "gpt-responses", api: "responses", reasoning_format: "responses.reasoning.v1",
    native_compaction_format: "responses.compaction.v1",
  },
  "claude-messages": {
    id: "claude-messages", api: "anthropic", reasoning_format: "anthropic.thinking.v1",
  },
  "deepseek-chat": {
    id: "deepseek-chat", api: "chat", reasoning_format: "reasoning.text.v1",
  },
};

/** Match Codex's Ultra resolution without rewriting the original catalog metadata. */
function ultraEffort(info: Record<string, any>, levels: string[]): string | undefined {
  const ordinary = levels.filter(level => level !== "ultra" && level !== "persistent");
  if (ordinary.includes(info.multi_agent_reasoning_effort)) return info.multi_agent_reasoning_effort;
  return ordinary.includes("max") ? "max" : ordinary.at(-1);
}

export function modelProfile(model: ModelConfig): ModelProfile {
  const entry = getCatalogEntry(model.catalog);
  const info = entry.model;
  const levels = info.supported_reasoning_levels.map((level: { effort: string }) => level.effort) as string[];
  const defaults = entry.effort_map ?? Object.fromEntries(levels.map(level => [
    level, level === "ultra" ? ultraEffort(info, levels) ?? level : level,
  ]));
  const effort_map = { ...(model.reasoning?.effort_map ?? defaults) };
  const multi_agent_effort = Object.hasOwn(effort_map, "ultra")
    ? Object.keys(effort_map).find(level => level !== "ultra" && level !== "persistent" && effort_map[level] === effort_map.ultra)
    : undefined;
  if (model.reasoning?.effort_map) {
    const descriptions = new Map(info.supported_reasoning_levels.map((level: { effort: string; description: string }) => [level.effort, level.description]));
    info.supported_reasoning_levels = Object.entries(effort_map).map(([effort, native]) => ({
      effort, description: descriptions.get(effort) ?? `Upstream effort: ${native}`,
    }));
    info.multi_agent_reasoning_effort = multi_agent_effort ?? null;
    if (!Object.hasOwn(effort_map, info.default_reasoning_level)) info.default_reasoning_level = Object.keys(effort_map)[0];
  }
  if (model.reasoning?.default_effort !== undefined) info.default_reasoning_level = model.reasoning.default_effort;
  if (model.context_window !== undefined) info.context_window = info.max_context_window = model.context_window;
  if (model.input_modalities !== undefined) info.input_modalities = [...model.input_modalities];
  return {
    ...FORMATS[entry.adapter], model_info: info, effort_map, multi_agent_effort,
    default_effort: info.default_reasoning_level, input_modalities: [...info.input_modalities],
  };
}

/** Catalog choices are defaults, not a server capability allowlist. */
export function reasoningEffort(route: ResolvedModel, requested?: string): string {
  const effort = requested ?? route.profile.default_effort;
  return Object.hasOwn(route.profile.effort_map, effort) ? route.profile.effort_map[effort] : effort;
}
