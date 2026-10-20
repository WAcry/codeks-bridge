import { encodeReasoning } from "../carrier.ts";
import { resolveClaudeOptions } from "../adapter-options.ts";
import { BridgeError, upstreamError } from "../errors.ts";
import { prepareHistory } from "../history.ts";
import { reasoningEffort, reasoningSummaryRequested } from "../profiles.ts";
import { parseJsonSse } from "../sse.ts";
import { safeCallId } from "../tools.ts";
import type { ToolSet } from "../tools.ts";
import type { Backend, BackendContext } from "../types.ts";
import { upstreamFetch } from "../upstream.ts";
import { buildAnthropicTools } from "./anthropic-tools.ts";

type Block = Record<string, any>;
interface Message { role: "user" | "assistant" | "system"; content: Block[] }
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

function contentBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) throw new BridgeError("Messages content must be text or an array.");
  return content.flatMap((part: any): Block[] => {
    if (["input_text", "output_text", "text"].includes(part.type)) {
      return part.text ? [{ type: "text", text: part.text }] : [];
    }
    if (part.type === "input_image" || part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url !== "string") throw new BridgeError("An image needs an image_url.");
      const data = /^data:(image\/(?:jpeg|png|gif|webp));base64,([\s\S]+)$/.exec(url);
      if (data) return [{ type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }];
      if (/^https?:\/\//.test(url)) return [{ type: "image", source: { type: "url", url } }];
      throw new BridgeError("Messages images must use an HTTP URL or a JPEG, PNG, GIF, or WebP base64 data URL.");
    }
    if (part.type === "refusal") return [{ type: "text", text: String(part.refusal ?? "") }];
    throw new BridgeError(`Unsupported Messages content type: ${String(part.type)}.`);
  });
}

function parseArguments(value: unknown): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new BridgeError("A tool call contains invalid JSON arguments."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeError("Messages tool arguments must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function toolChoice(value: any, tools: ToolSet): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return { type: "auto" };
  if (value === "none") return { type: "none" };
  if (value === "required") return { type: "any" };
  if (value && ["function", "custom"].includes(value.type) && typeof value.name === "string") {
    const selected = tools.get(value.namespace, value.name);
    if (!selected || selected.kind !== value.type) {
      throw new BridgeError("The selected tool is not available on the Messages backend.");
    }
    return { type: "tool", name: selected.flatName };
  }
  throw new BridgeError("Unsupported Messages tool_choice.");
}

/** Convert only request-owned copies; stored history remains unchanged. */
export function buildAnthropicRequest(context: BackendContext): { body: Record<string, any>; tools: ToolSet; betas: string[] } {
  const { route } = context;
  const request = context.request;
  const settings = resolveClaudeOptions(route);
  const { tools, definitions, input } = buildAnthropicTools(request, settings.tool_updates);
  const system: Block[] = request.instructions ? [{ type: "text", text: request.instructions }] : [];
  const messages: Message[] = [];
  let additions: Block[] = [];
  let hasInlineTools = false;
  const continueAssistant = () => {
    const tail = messages.at(-1);
    if (tail?.role === "assistant" && !tail.content.some(block => block.type === "tool_use")) {
      messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
    }
  };
  const flushAdditions = () => {
    if (!additions.length) return;
    // A persisted declaration also anchors this boundary on later replays.
    continueAssistant();
    if (messages.at(-1)?.role !== "user") {
      throw new BridgeError("Inline tool declarations require a user or completed tool-result boundary.");
    }
    messages.push({ role: "system", content: additions });
    additions = [];
    hasInlineTools = true;
  };
  const append = (role: Message["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    // Several reminders/results may share a user turn. Tool declarations take
    // effect after that complete boundary, before the next assistant step.
    if (role === "assistant") flushAdditions();
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const item of prepareHistory(input, route)) {
    if (item.type === "additional_tools") {
      additions.push(...item.tools.map((definition: Block) => ({
        type: "tool_addition", tool: { type: "tool_definition", definition },
      })));
    } else if (item.type === "bridge_reasoning") {
      const block = item.state.data;
      if (!block || !["thinking", "redacted_thinking"].includes(block.type)) {
        throw new BridgeError("Invalid Messages reasoning carrier.");
      }
      append("assistant", [block]);
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      append("assistant", [{
        type: "tool_use", id: safeCallId(item.call_id), name: tools.flatFor(item.namespace, item.name),
        input: item.type === "custom_tool_call" ? { input: item.input } : parseArguments(item.arguments),
      }]);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const content = contentBlocks(item.output);
      append("user", [{ type: "tool_result", tool_use_id: safeCallId(item.call_id), ...(content.length ? { content } : {}) }]);
    } else if (item.type === "message" || item.role) {
      const blocks = contentBlocks(item.content);
      if (item.role === "developer" || item.role === "system") {
        if (blocks.some((block) => block.type !== "text")) throw new BridgeError("System messages must contain text.");
        if (!messages.length) system.push(...blocks);
        // Inline system roles have placement restrictions that arbitrary Responses
        // history cannot satisfy. Keep reminders in order without rewriting a
        // signed assistant prefix or moving new instructions to the beginning.
        else append("user", [{ type: "text", text: `<system-reminder>\n${blocks.map((block) => block.text).join("\n\n")}\n</system-reminder>` }]);
      } else if (item.role === "assistant" || item.role === "user") {
        append(item.role, blocks);
      } else throw new BridgeError(`Unsupported Messages role: ${String(item.role)}.`);
    } else throw new BridgeError(`Unsupported Messages history item: ${String(item.type)}.`);
  }
  // A failed response can leave a complete thinking/text item in codeks history.
  // Claude requires a user boundary to resume. Do not mask a missing tool result.
  continueAssistant();
  flushAdditions();
  // Keep stable prefixes at 1h. The one-off compaction suffix uses 5m.
  const cache = (block: Block | undefined, ttl: "1h" | "5m" = "1h") => {
    if (block) block.cache_control = { type: "ephemeral", ttl };
  };
  cache(definitions.at(-1));
  cache(system.at(-1));
  const userMessages = messages.filter((message) => message.role === "user");
  for (const message of userMessages.slice(-2)) {
    cache(message.content.at(-1), context.compacting && message === userMessages.at(-1) ? "5m" : "1h");
  }

  const effort = reasoningEffort(route, request.reasoning?.effort);
  const body: Record<string, any> = {
    thinking: effort === "none" ? { type: "disabled" } : {
      type: "adaptive", display: reasoningSummaryRequested(request) ? "summarized" : "omitted",
    },
    ...(effort !== "none" ? { output_config: { effort } } : {}),
    max_tokens: request.max_output_tokens ?? route.profile.max_output_tokens,
  };
  for (const name of ["temperature", "top_p"] as const) {
    if (request[name] !== undefined) body[name] = request[name];
  }
  let choice = toolChoice(request.tool_choice, tools);
  if (tools.entries.length && typeof request.parallel_tool_calls === "boolean" && choice?.type !== "none") {
    choice = { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: !request.parallel_tool_calls };
  }
  if (choice) body.tool_choice = choice;
  const format = request.text?.format;
  if (format !== undefined && format.type !== "text") {
    if (format.type !== "json_schema") throw new BridgeError(`Messages does not support text format ${String(format.type)}.`);
    body.output_config = { ...body.output_config, format: { type: "json_schema", schema: format.schema } };
  }
  Object.assign(body, route.upstream.options, route.config.options, {
    model: route.config.model, messages, stream: true,
  });
  // Native options remain authoritative. Modes such as between_tools do not
  // support binding controls; do not change the caller's chosen thinking mode.
  if (["adaptive", "enabled"].includes(body.thinking?.type) &&
      settings.thinking_mismatch !== "upstream_default") {
    body.thinking = {
      ...body.thinking,
      block_binding: {
        prefix_mismatch_behavior: settings.thinking_mismatch,
        ...body.thinking.block_binding,
      },
    };
  }
  if (system.length) body.system = system;
  else delete body.system;
  if (definitions.length) body.tools = definitions;
  else delete body.tools;
  if (context.compacting) {
    if (body.output_config) {
      body.output_config = { ...body.output_config };
      delete body.output_config.format;
    }
  }
  return { body, tools, betas: [THINKING_BINDING_BETA, ...(hasInlineTools ? [INLINE_TOOLS_BETA] : [])] };
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BridgeError("Messages stream has invalid or missing token usage.", "upstream_error", 502);
  }
  return value;
}

function validateUsage(value: any, required: string[]): void {
  for (const field of required) tokenCount(value?.[field]);
  for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    if (value?.[field] !== undefined) tokenCount(value[field]);
  }
  if (value?.output_tokens_details?.thinking_tokens !== undefined) tokenCount(value.output_tokens_details.thinking_tokens);
}

export const runAnthropic: Backend = async (context, writer) => {
  const { body, tools, betas } = buildAnthropicRequest(context);
  const response = await upstreamFetch(context.route, "/messages", body, context.signal, context.requestHeaders, { "anthropic-beta": betas });
  context.onAccepted?.(response.headers);
  if (!response.body) throw new BridgeError("Messages returned an empty stream.", "upstream_error", 502);
  const blocks = new Map<number, { value: Block; json: string }>();
  let rawUsage: Block = {};
  let started = false;
  let finalUsage = false;
  let stopReason: string | undefined;
  let stopped = false;
  for await (const { json: event } of parseJsonSse(response.body)) {
    if (event.type === "error") throw upstreamError(undefined, event, response.headers);
    if (event.type === "ping") { writer.keepalive(); continue; }
    if (event.type === "message_start") {
      validateUsage(event.message?.usage, ["input_tokens", "output_tokens"]);
      started = true;
      rawUsage = { ...rawUsage, ...event.message?.usage };
    } else if (event.type === "content_block_start") {
      const value: Block = { ...event.content_block };
      if (!["text", "thinking", "redacted_thinking", "tool_use"].includes(value.type)) {
        throw new BridgeError(`Unsupported Messages output block: ${String(value.type)}.`);
      }
      blocks.set(event.index, { value, json: "" });
      if (value.type === "text" && value.text) writer.textDelta(value.text);
      if (value.type === "thinking") writer.reasoningDelta(value.thinking ?? "");
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (!block) throw new BridgeError("Messages sent a delta before its block.", "upstream_error", 502);
      const delta = event.delta;
      if (delta.type === "text_delta") {
        block.value.text = (block.value.text ?? "") + delta.text;
        writer.textDelta(delta.text);
      } else if (delta.type === "thinking_delta") {
        block.value.thinking = (block.value.thinking ?? "") + delta.thinking;
        writer.reasoningDelta(delta.thinking);
      } else if (delta.type === "signature_delta") {
        block.value.signature = (block.value.signature ?? "") + delta.signature;
      } else if (delta.type === "input_json_delta") block.json += delta.partial_json;
      else if (delta.type !== "citations_delta") throw new BridgeError(`Unsupported Messages delta: ${String(delta.type)}.`);
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(event.index);
      if (!block) throw new BridgeError("Messages stopped an unknown block.", "upstream_error", 502);
      if (block.value.type === "thinking" || block.value.type === "redacted_thinking") {
        writer.endReasoning(encodeReasoning({ source: context.route.origin, format: context.route.profile.reasoning_format, data: block.value }));
      } else if (block.value.type === "tool_use") {
        if (block.json) block.value.input = parseArguments(block.json);
        const call = block.value;
        const tool = tools.resolve(call.name);
        if (!tool) throw new BridgeError(`Messages called an unknown tool: ${String(call.name)}.`);
        if (tool.kind === "custom") {
          if (typeof call.input?.input !== "string") throw new BridgeError("A custom tool call needs a string input.");
          writer.addCustomToolCall({ call_id: call.id, name: tool.name, namespace: tool.namespace, input: call.input.input });
        } else writer.addFunctionCall({ call_id: call.id, name: tool.name, namespace: tool.namespace, arguments: JSON.stringify(call.input ?? {}) });
      } else if (block.value.type === "text") writer.closeMessage();
      blocks.delete(event.index);
    } else if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      validateUsage(event.usage, ["output_tokens"]);
      finalUsage = true;
      rawUsage = { ...rawUsage, ...event.usage };
    } else if (event.type === "message_stop") stopped = true;
  }
  if (!started || !stopped || blocks.size || !stopReason) {
    throw new BridgeError("Messages stream ended before the message was complete.", "upstream_error", 502);
  }
  if (stopReason === "model_context_window_exceeded") {
    throw new BridgeError("Messages reached the model context window before completing the response.", "context_length_exceeded");
  }
  if (stopReason === "max_tokens" || stopReason === "refusal") {
    throw new BridgeError(stopReason === "max_tokens" ? "Messages reached max_tokens before completing the response." : "Messages refused the request.");
  }
  if (!["end_turn", "stop_sequence", "tool_use", "pause_turn"].includes(stopReason)) {
    throw new BridgeError(`Unsupported Messages stop reason: ${stopReason}.`);
  }
  if (!finalUsage) throw new BridgeError("Messages stream ended without final token usage.", "upstream_error", 502);
  const usage = {
    input_tokens: tokenCount(rawUsage.input_tokens + (rawUsage.cache_read_input_tokens ?? 0) + (rawUsage.cache_creation_input_tokens ?? 0)),
    cached_tokens: rawUsage.cache_read_input_tokens ?? 0,
    cache_write_tokens: rawUsage.cache_creation_input_tokens ?? 0,
    output_tokens: tokenCount(rawUsage.output_tokens),
    ...(rawUsage.output_tokens_details?.thinking_tokens != null ? { reasoning_tokens: rawUsage.output_tokens_details.thinking_tokens } : {}),
  };
  return {
    usage,
    endTurn: stopReason !== "tool_use" && stopReason !== "pause_turn",
  };
};
