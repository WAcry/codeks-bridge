import type { AdapterId, ModelConfig, ModelProfile, ResolvedModel } from "./types.ts";

const LEVELS = { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", ultra: "max" };

/** Wire formats and defaults live here; endpoint capabilities are configuration. */
export const PROFILES: Record<AdapterId, ModelProfile> = {
  "gpt-responses": {
    id: "gpt-responses", api: "responses", reasoning_format: "responses.reasoning.v1",
    native_compaction_format: "responses.compaction.v1", default_effort: "medium",
    effort_map: LEVELS, input_modalities: ["text", "image"],
  },
  "claude-messages": {
    id: "claude-messages", api: "anthropic", reasoning_format: "anthropic.thinking.v1",
    default_effort: "medium", effort_map: { none: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    input_modalities: ["text", "image"],
  },
  "deepseek-chat": {
    id: "deepseek-chat", api: "chat", reasoning_format: "reasoning.text.v1",
    default_effort: "high", effort_map: { none: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max" },
    input_modalities: ["text", "image"],
  },
};

export function modelProfile(model: ModelConfig): ModelProfile {
  const defaults = PROFILES[model.adapter];
  const effort_map = model.reasoning?.effort_map ?? defaults.effort_map;
  return {
    ...defaults,
    effort_map: { ...effort_map },
    // codeks resolves its Ultra UI mode before the request reaches the bridge.
    multi_agent_effort: Object.hasOwn(effort_map, "ultra")
      ? Object.keys(effort_map).find(level => level !== "ultra" && level !== "persistent" && effort_map[level] === effort_map.ultra)
      : undefined,
    default_effort: model.reasoning?.default_effort ?? (Object.hasOwn(effort_map, defaults.default_effort) ? defaults.default_effort : Object.keys(effort_map)[0]),
    input_modalities: [...(model.input_modalities ?? defaults.input_modalities)],
  };
}

/** Catalog choices are defaults, not a server capability allowlist. */
export function reasoningEffort(route: ResolvedModel, requested?: string): string {
  const effort = requested ?? route.profile.default_effort;
  return Object.hasOwn(route.profile.effort_map, effort) ? route.profile.effort_map[effort] : effort;
}
