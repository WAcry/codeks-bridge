import { BridgeError } from "./errors.ts";
import type { AdapterId, ClaudeMessagesOptions, ResolvedModel } from "./types.ts";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validate bridge-owned settings; native options stay open to upstream extensions. */
export function validateAdapterConfig(value: unknown, location: string, adapter?: AdapterId): void {
  if (value === undefined) return;
  function fail(message: string): never {
    throw new BridgeError(`Invalid configuration: ${location}.adapters: ${message}`);
  }
  if (!object(value)) fail("must be an object");
  for (const [name, settings] of Object.entries(value)) {
    if (name !== "claude-messages") fail(`unknown adapter settings ${name}`);
    if (adapter !== undefined && name !== adapter) fail(`${name} does not match the model adapter ${adapter}`);
    if (!object(settings)) fail(`${name} must be an object`);
    for (const field of Object.keys(settings)) {
      if (field !== "tool_updates" && field !== "thinking_mismatch") fail(`unknown ${name} setting ${field}`);
    }
    if (settings.tool_updates !== undefined && !["inline", "top_level"].includes(settings.tool_updates as string)) {
      fail(`${name}.tool_updates must be inline or top_level`);
    }
    if (settings.thinking_mismatch !== undefined && !["drop_block", "error", "upstream_default"].includes(settings.thinking_mismatch as string)) {
      fail(`${name}.thinking_mismatch must be drop_block, error, or upstream_default`);
    }
  }
}

/** Model leaves override connection leaves; neither is part of state provenance. */
export function resolveClaudeOptions(route: Pick<ResolvedModel, "upstream" | "config">): ClaudeMessagesOptions {
  const upstream = route.upstream.adapters?.["claude-messages"];
  const model = route.config.adapters?.["claude-messages"];
  return {
    tool_updates: model?.tool_updates ?? upstream?.tool_updates ?? "inline",
    thinking_mismatch: model?.thinking_mismatch ?? upstream?.thinking_mismatch ?? "drop_block",
  };
}
