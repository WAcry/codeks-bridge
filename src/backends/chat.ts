import { encodeReasoning } from "../carrier.ts";
import { BridgeError, transportError, upstreamError } from "../errors.ts";
import { isOpaqueStateItem, prepareHistory } from "../history.ts";
import { parseJsonSse } from "../sse.ts";
import { buildToolSet, normalizeToolDeclarations } from "../tools.ts";
import type { ToolSet } from "../tools.ts";
import type { BackendContext, BackendResult } from "../types.ts";
import { upstreamFetch } from "../upstream.ts";
import type { ResponseWriter, Usage } from "../writer.ts";

/** A wire dialect supplies only the parts that differ from Chat Completions. */
export interface ChatDialect {
  reasoningField: string;
  requestParameters(context: BackendContext): Record<string, unknown>;
  readUsage(value: any): Usage;
  failureReason(reason: string): BridgeError | undefined;
}

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
    if (isOpaqueStateItem(item)) {
      flushImages();
      // Do not invent a text or reasoning_content interpretation for opaque data.
      const a = getAssistant();
      if (typeof a.content === "string") a.content = a.content ? [{ type: "text", text: a.content }] : [];
      a.content.push(item);
    } else if (item.type === "bridge_reasoning") {
      flushImages();
      // A reasoning item starts the next assistant response, even if the
      // previous response ended without a tool or user message.
      flushAssistant();
      if (typeof item.state.data !== "string") throw new BridgeError("Invalid Chat reasoning data.");
      getAssistant()[reasoningField] = item.state.data;
    } else if (item.type === "message" || (!item.type && item.role)) {
      const parts = contentParts(item.content);
      if (item.role === "assistant") {
        flushImages();
        if (parts.some((p) => p.type !== "text")) throw new BridgeError("Chat assistant history cannot contain images.");
        const a = getAssistant();
        const text = messageContent(parts) as string;
        if (Array.isArray(a.content)) a.content.push(...parts);
        else a.content += (a.content && text ? "\n" : "") + text;
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
      const tool = tools.get(selected.namespace, selected.name);
      if (!tool || tool.kind !== selected.type) {
        throw new BridgeError("The selected tool is not available on the Chat backend.");
      }
      return { type: "function", function: { name: tool.flatName } };
    }
  }
  throw new BridgeError("Chat does not support this tool_choice.");
}

export function buildChatRequest(context: BackendContext, dialect: ChatDialect): { body: Record<string, any>; tools: ToolSet } {
  context = { ...context, request: normalizeToolDeclarations(context.request) };
  const { request, route } = context;
  const tools = buildToolSet(request.tools);
  const body: Record<string, any> = { ...dialect.requestParameters(context) };
  const limit = request.max_output_tokens ?? route.profile.max_output_tokens;
  if (limit !== undefined) body.max_tokens = limit;
  for (const name of ["temperature", "top_p", "parallel_tool_calls"] as const) {
    if (request[name] !== undefined) body[name] = request[name];
  }
  const choice = toolChoice(request.tool_choice, tools);
  if (choice !== undefined) body.tool_choice = choice;
  const format = request.text?.format;
  if (format?.type === "json_object") body.response_format = { type: "json_object" };
  else if (format?.type === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: format.name, schema: format.schema, strict: format.strict } };
  } else if (format && format.type !== "text") throw new BridgeError(`Chat does not support text format ${String(format.type)}.`);
  Object.assign(body, route.upstream.options, route.config.options, {
    model: route.config.model,
    messages: convertHistory(context, tools, dialect.reasoningField),
    stream: true,
  });
  body.stream_options = { ...body.stream_options, include_usage: true };
  if (tools.entries.length) body.tools = tools.entries.map((tool) => ({
    type: "function", function: {
      name: tool.flatName, description: tool.description, parameters: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  }));
  else delete body.tools;
  if (context.compacting) {
    delete body.response_format;
  }
  return { body, tools };
}

async function* chatEvents(body: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  try {
    yield* parseJsonSse(body);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw transportError(error);
  }
}

export async function runChat(context: BackendContext, writer: ResponseWriter, dialect: ChatDialect): Promise<BackendResult> {
  const { body, tools } = buildChatRequest(context, dialect);
  const { reasoningField } = dialect;
  const response = await upstreamFetch(context.route, "chat/completions", body, context.signal, context.requestHeaders);
  context.onAccepted?.(response.headers);
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
      writer.endReasoning(encodeReasoning({ source: context.route.origin, format: context.route.profile.reasoning_format, data: reasoning }));
      reasoningClosed = true;
    }
  };
  for await (const { json } of chatEvents(response.body, context.signal)) {
    if (json.error) throw upstreamError(undefined, json, response.headers);
    if (json.usage) usage = dialect.readUsage(json.usage);
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
  const failure = dialect.failureReason(finish);
  if (failure) throw failure;
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
}
