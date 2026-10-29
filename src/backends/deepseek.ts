import { BridgeError } from "../errors.ts";
import { reasoningEffort } from "../profiles.ts";
import type { Backend, BackendContext } from "../types.ts";
import { buildChatRequest, runChat } from "./chat.ts";
import type { ChatDialect } from "./chat.ts";

const deepseek: ChatDialect = {
  reasoningField: "reasoning_content",
  requestParameters({ request, route }) {
    return {
      thinking: { type: "enabled" },
      reasoning_effort: reasoningEffort(route, request.reasoning?.effort),
    };
  },
  configureStructuredOutput({ request, route }, body) {
    const format = request.text?.format;
    if (!format || format.type === "text") return;
    // Explicit native options own their schema and must not receive a conflicting reminder.
    if (Object.hasOwn(route.upstream.options ?? {}, "response_format") ||
        Object.hasOwn(route.config.options ?? {}, "response_format")) return;
    if (format.type === "json_object") {
      body.response_format = { type: "json_object" };
      return;
    }
    if (format.type !== "json_schema") throw new BridgeError(`DeepSeek does not support text format ${String(format.type)}.`);
    if (!format.schema || typeof format.schema !== "object" || Array.isArray(format.schema)) {
      throw new BridgeError("JSON schema output requires a schema object.");
    }
    body.response_format = { type: "json_object" };
    // Append only to this request's suffix; keep the preceding conversation unchanged.
    body.messages.push({
      role: "system",
      content: "Your final response must be a single JSON object matching the following JSON Schema. Do not wrap it in Markdown.\n" +
        JSON.stringify(format.schema),
    });
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
