import { BridgeError } from "../errors.ts";
import { reasoningEffort } from "../profiles.ts";
import type { Backend, BackendContext } from "../types.ts";
import { buildChatRequest, runChat } from "./chat.ts";
import type { ChatDialect } from "./chat.ts";

const deepseek: ChatDialect = {
  reasoningField: "reasoning_content",
  requestParameters({ request, route }) {
    const effort = reasoningEffort(route, request.reasoning?.effort);
    return effort === "none"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: effort };
  },
  failureReason(reason) {
    if (reason === "insufficient_system_resource" || reason === "aborted") {
      return new BridgeError(`DeepSeek generation stopped with ${reason}.`, "server_is_overloaded", 503);
    }
  },
  readUsage(value) {
    const count = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new BridgeError("Chat stream has no valid token usage.", "upstream_error", 502);
      }
      return value;
    };
    const cached = value?.prompt_cache_hit_tokens ?? value?.prompt_tokens_details?.cached_tokens;
    const reasoning = value?.completion_tokens_details?.reasoning_tokens;
    return {
      input_tokens: count(value?.prompt_tokens),
      output_tokens: count(value?.completion_tokens),
      ...(cached !== undefined ? { cached_tokens: count(cached) } : {}),
      ...(reasoning !== undefined ? { reasoning_tokens: count(reasoning) } : {}),
    };
  },
};

export function buildDeepSeekRequest(context: BackendContext) {
  return buildChatRequest(context, deepseek);
}

export const runDeepSeek: Backend = (context, writer) => runChat(context, writer, deepseek);
