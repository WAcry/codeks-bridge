import { decodeJsonPayload, decodeReasoning, encodeJsonPayload, encodeReasoning } from "../carrier.ts";
import { BridgeError } from "../errors.ts";
import { prepareHistory } from "../history.ts";
import { parseJsonSse } from "../sse.ts";
import { buildToolSet } from "../tools.ts";
import type { ToolSet } from "../tools.ts";
import type { Backend, BackendContext } from "../types.ts";
import { upstreamFetch } from "../upstream.ts";
import type { Usage } from "../writer.ts";

type Message = Record<string, any>;
type Part = Record<string, any>;

function contentParts(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new BridgeError("Chat message content must be text or a content array.");
  return content.map((part) => {
    if (["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (part?.type === "refusal" && typeof part.refusal === "string") return { type: "text", text: part.refusal };
    if (part?.type === "input_image" && typeof part.image_url === "string") {
      if (!/^(https?:\/\/|data:image\/)/.test(part.image_url)) {
        throw new BridgeError("Chat images require an HTTP(S) URL or an image data URL.");
      }
      return { type: "image_url", image_url: {
        url: part.image_url,
        ...(part.detail ? { detail: part.detail === "original" ? "high" : part.detail } : {}),
      } };
    }
    throw new BridgeError(`Chat does not support content part ${String(part?.type)}.`);
  });
}

function messageContent(parts: Part[]): string | Part[] {
  return parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts;
}

function convertHistory(context: BackendContext, tools: ToolSet, reasoningField: string): Message[] {
  const messages: Message[] = [];
  let assistant: Message | undefined;
  let pendingImages: Part[] = [];
  const flushAssistant = () => {
    if (assistant) messages.push(assistant);
    assistant = undefined;
  };
  const flushImages = () => {
    if (pendingImages.length) messages.push({ role: "user", content: pendingImages });
    pendingImages = [];
  };
  const getAssistant = () => assistant ??= { role: "assistant", content: "", [reasoningField]: "" };
  if (context.request.instructions) messages.push({ role: "system", content: context.request.instructions });

  for (const item of prepareHistory(context.request.input, context.route)) {
    if (item.type === "reasoning") {
      flushImages();
      // A reasoning item starts the next assistant response, even if the
      // previous response ended without a tool or user message.
      flushAssistant();
      const carrier = decodeReasoning(item.encrypted_content);
      if (!carrier || carrier.key !== context.route.key) continue;
      const payload = decodeJsonPayload<{ type: string; text: string }>(carrier.payload);
      if (!payload || payload.type !== "chat" || typeof payload.text !== "string") {
        throw new BridgeError("Invalid Chat reasoning carrier.");
      }
      getAssistant()[reasoningField] = payload.text;
    } else if (item.type === "message" || (!item.type && item.role)) {
      const parts = contentParts(item.content);
      if (item.role === "assistant") {
        flushImages();
        if (parts.some((p) => p.type !== "text")) throw new BridgeError("Chat assistant history cannot contain images.");
        const a = getAssistant();
        const text = messageContent(parts) as string;
        a.content += (a.content && text ? "\n" : "") + text;
      } else {
        flushAssistant();
        flushImages();
        if (!["system", "developer", "user"].includes(item.role)) {
          throw new BridgeError(`Chat does not support message role ${String(item.role)}.`);
        }
        if (item.role !== "user" && parts.some((p) => p.type !== "text")) {
          throw new BridgeError("Chat system and developer messages must contain text only.");
        }
        messages.push({ role: item.role === "developer" ? "system" : item.role, content: messageContent(parts) });
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      flushImages();
      if (typeof item.call_id !== "string" || typeof item.name !== "string") throw new BridgeError("Invalid Chat tool call history.");
      const a = getAssistant();
      a.tool_calls ??= [];
      a.tool_calls.push({
        id: item.call_id, type: "function", function: {
          name: tools.flatFor(item.namespace, item.name),
          arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments,
        },
      });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      flushAssistant();
      if (typeof item.call_id !== "string") throw new BridgeError("Chat tool output has no call_id.");
      const parts = contentParts(item.output);
      const images = parts.filter((p) => p.type === "image_url");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: messageContent(parts.filter((p) => p.type === "text")) });
      if (images.length) {
        pendingImages.push({ type: "text", text: `Images from tool call ${item.call_id}:` }, ...images);
      }
    } else {
      throw new BridgeError(`Chat does not support history item ${String(item.type)}.`);
    }
  }
  flushAssistant();
  flushImages();
  return messages;
}

function toolChoice(choice: unknown, tools: ToolSet): unknown {
  if (choice === undefined) return undefined;
  if (["auto", "none", "required"].includes(choice as string)) return choice;
  if (choice && typeof choice === "object") {
    const selected = choice as Record<string, any>;
    if (["function", "custom"].includes(selected.type) && typeof selected.name === "string") {
      const name = tools.flatFor(selected.namespace, selected.name);
      const tool = tools.resolve(name);
      if (!tool || tool.name !== selected.name || tool.namespace !== selected.namespace || tool.kind !== selected.type) {
        throw new BridgeError("The selected tool is not available on the Chat backend.");
      }
      return { type: "function", function: { name } };
    }
  }
  throw new BridgeError("Chat does not support this tool_choice.");
}

export function buildChatRequest(context: BackendContext): { body: Record<string, any>; tools: ToolSet; reasoningField: string } {
  const { request, route } = context;
  const tools = buildToolSet(request.tools);
  const options = { ...route.upstream.options, ...route.config.options };
  const reasoningField = options.reasoning_field ?? "reasoning_content";
  if (typeof reasoningField !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(reasoningField) || ["role", "content", "tool_calls", "refusal"].includes(reasoningField)) {
    throw new BridgeError("options.reasoning_field must name a separate Chat message field.");
  }
  delete options.reasoning_field;
  const body: Record<string, any> = {
    ...options,
    model: route.config.model,
    messages: convertHistory(context, tools, reasoningField),
    stream: true,
    stream_options: { include_usage: true },
  };
  const limit = request.max_output_tokens ?? route.config.max_output_tokens;
  if (limit !== undefined) body.max_tokens = limit;
  for (const name of ["temperature", "top_p", "parallel_tool_calls"] as const) {
    if (request[name] !== undefined) body[name] = request[name];
  }
  const effort = request.reasoning?.effort;
  if (effort !== undefined) {
    if (route.config.model.startsWith("deepseek-")) {
      const levels: Record<string, string> = { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max" };
      if (effort === "none") {
        body.thinking = { type: "disabled" };
        delete body.reasoning_effort;
      } else {
        if (!levels[effort]) throw new BridgeError(`Unsupported Chat reasoning effort ${effort}.`);
        body.thinking = { type: "enabled" };
        body.reasoning_effort = levels[effort];
      }
    } else body.reasoning_effort = effort;
  }
  if (tools.entries.length) body.tools = tools.entries.map((tool) => ({
    type: "function", function: { name: tool.flatName, description: tool.description, parameters: tool.parameters },
  }));
  else delete body.tools;
  const choice = toolChoice(context.compacting ? "none" : request.tool_choice, tools);
  if (choice !== undefined) body.tool_choice = choice;
  if (route.config.model.startsWith("deepseek-") && body.thinking?.type !== "disabled" &&
      (choice === "required" || (choice && typeof choice === "object"))) {
    throw new BridgeError("DeepSeek thinking mode does not support forced tool_choice; use reasoning.effort=none.");
  }
  const format = request.text?.format;
  if (format?.type === "json_object") body.response_format = { type: "json_object" };
  else if (format?.type === "json_schema" && !route.config.model.startsWith("deepseek-")) {
    body.response_format = { type: "json_schema", json_schema: { name: format.name, schema: format.schema, strict: format.strict } };
  } else if (format && format.type !== "text") throw new BridgeError(`Chat does not support text format ${String(format.type)} for this model.`);
  return { body, tools, reasoningField };
}

function readUsage(value: any): Usage {
  if (!Number.isFinite(value?.prompt_tokens) || !Number.isFinite(value?.completion_tokens)) {
    throw new BridgeError("Chat stream has no valid token usage.", "upstream_error", 502);
  }
  return {
    input_tokens: value.prompt_tokens,
    output_tokens: value.completion_tokens,
    cached_tokens: value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0,
    reasoning_tokens: value.completion_tokens_details?.reasoning_tokens,
  };
}

async function* chatEvents(body: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  try {
    yield* parseJsonSse(body);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("Chat stream was interrupted or contained invalid JSON.", "upstream_error", 502);
  }
}

export const runChat: Backend = async (context, writer) => {
  const { body, tools, reasoningField } = buildChatRequest(context);
  const response = await upstreamFetch(context.route, "chat/completions", body, context.signal);
  if (!response.body) throw new BridgeError("Chat upstream returned no stream.", "upstream_error", 502);
  let reasoning = "";
  let reasoningSeen = false;
  let reasoningClosed = false;
  let finish: string | undefined;
  let usage: Usage | undefined;
  let visible = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const closeReasoning = () => {
    if (reasoningSeen && !reasoningClosed) {
      writer.endReasoning(encodeReasoning(context.route.key, encodeJsonPayload({ type: "chat", text: reasoning })));
      reasoningClosed = true;
    }
  };
  for await (const { json } of chatEvents(response.body, context.signal)) {
    if (json.error) {
      const err = json.error;
      const code = err.code ?? err.type;
      const normalized = /quota|balance/.test(code) ? "insufficient_quota" : /rate_limit/.test(code) ? "rate_limit_exceeded" : /overload/.test(code) ? "server_is_overloaded" : /context.*length/.test(code) ? "context_length_exceeded" : /invalid/.test(code) ? "invalid_prompt" : "upstream_error";
      throw new BridgeError(String(err.message ?? "Chat stream failed."), normalized, 502);
    }
    if (json.usage) usage = readUsage(json.usage);
    for (const choice of json.choices ?? []) {
      if (choice.index !== 0) throw new BridgeError("Chat returned more than one completion.", "upstream_error", 502);
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (delta.refusal) throw new BridgeError(String(delta.refusal));
      if (delta[reasoningField] !== undefined && delta[reasoningField] !== null) {
        if (typeof delta[reasoningField] !== "string" || reasoningClosed) throw new BridgeError("Chat returned unsupported reasoning ordering or content.", "upstream_error", 502);
        reasoningSeen = true;
        reasoning += delta[reasoningField];
        writer.reasoningDelta(delta[reasoningField]);
      }
      if (delta.content !== undefined && delta.content !== null && delta.content !== "") {
        if (typeof delta.content !== "string") throw new BridgeError("Chat returned non-text output.", "upstream_error", 502);
        closeReasoning();
        writer.textDelta(delta.content);
        visible = true;
      }
      for (const part of delta.tool_calls ?? []) {
        if (!Number.isInteger(part.index) || part.index < 0 || (part.type && part.type !== "function")) {
          throw new BridgeError("Chat returned an invalid tool call.", "upstream_error", 502);
        }
        const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (part.id) call.id += part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
    }
  }
  if (!finish) throw new BridgeError("Chat stream ended before a finish_reason.", "upstream_error", 502);
  if (finish === "length") throw new BridgeError("Chat output reached its token limit; increase max_output_tokens.");
  if (finish === "insufficient_system_resource" || finish === "aborted") {
    throw new BridgeError("Chat generation was interrupted by the upstream.", "server_is_overloaded", 503);
  }
  if (finish !== "stop" && finish !== "tool_calls") throw new BridgeError(`Chat stopped with ${finish}.`);
  if (!usage) throw new BridgeError("Chat stream ended without token usage.", "upstream_error", 502);
  if (finish === "tool_calls" && !calls.size) throw new BridgeError("Chat ended with tool_calls but returned no calls.", "upstream_error", 502);
  if (!visible && !calls.size) throw new BridgeError("Chat returned no text or tool calls.", "upstream_error", 502);
  closeReasoning();
  // Validate every call before exposing any of them for execution.
  const completed = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    const tool = tools.resolve(call.name);
    if (!tool || !call.id) throw new BridgeError("Chat returned an unknown or incomplete tool call.", "upstream_error", 502);
    let args: any;
    try { args = JSON.parse(call.arguments); } catch { throw new BridgeError("Chat returned invalid tool arguments.", "upstream_error", 502); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new BridgeError("Chat tool arguments must be an object.", "upstream_error", 502);
    if (tool.kind === "custom" && typeof args.input !== "string") throw new BridgeError("Chat custom tool call has no string input.", "upstream_error", 502);
    return { call, tool, args };
  });
  for (const { call, tool, args } of completed) {
    if (tool.kind === "custom") writer.addCustomToolCall({ call_id: call.id, name: tool.name, namespace: tool.namespace, input: args.input });
    else writer.addFunctionCall({ call_id: call.id, name: tool.name, namespace: tool.namespace, arguments: call.arguments });
  }
  return { usage, endTurn: calls.size === 0 };
};
