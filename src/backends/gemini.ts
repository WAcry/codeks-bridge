import { isDeepStrictEqual } from "node:util";
import { encodeReasoning } from "../carrier.ts";
import { BridgeError, transportError, upstreamError } from "../errors.ts";
import { isOpaqueStateItem, prepareHistory } from "../history.ts";
import { newId } from "../ids.ts";
import { reasoningEffort, reasoningSummaryRequested } from "../profiles.ts";
import { parseJsonSse } from "../sse.ts";
import { prepareToolCall, toolCallForReplay, toolResultForReplay, writeToolCall } from "../tool-calls.ts";
import { buildToolSet, normalizeToolDeclarations, type ToolSet } from "../tools.ts";
import type { Backend, BackendContext } from "../types.ts";
import { upstreamFetch } from "../upstream.ts";
import type { Usage } from "../writer.ts";

type Part = Record<string, any>;
interface Projection { type: "message" | "function_call"; call_id?: string }
interface NativeParts { parts: Part[]; projection?: Projection; continuation_before?: string }
interface Entry { parts: Part[]; projection?: Projection; custom?: boolean }
interface Content { role: "user" | "model"; parts: Part[] }
const IMPORTED_SIGNATURE = "skip_thought_signature_validator";

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(parts: Part[]): string {
  return parts.filter(part => typeof part.text === "string").map(part => part.text).join("");
}

function contentParts(content: unknown): Part[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) throw new BridgeError("Gemini content must be text or a content array.");
  return content.map((part): Part => {
    if (["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string") return { text: part.text };
    if (part?.type === "refusal" && typeof part.refusal === "string") return { text: part.refusal };
    if (part?.type === "input_image" || part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url !== "string") throw new BridgeError("A Gemini image needs an image_url.");
      const data = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(url);
      if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
      if (/^(https?:\/\/|gs:\/\/)/.test(url)) return { fileData: { fileUri: url } };
      throw new BridgeError("Gemini images require an HTTP(S), Cloud Storage, or image data URL.");
    }
    throw new BridgeError(`Unsupported Gemini content type: ${String(part?.type)}.`);
  });
}

function parseArguments(value: unknown): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new BridgeError("A Gemini tool call contains invalid JSON arguments."); }
  if (!object(parsed)) throw new BridgeError("Gemini tool arguments must be an object.");
  return parsed;
}

function toolChoice(value: any, tools: ToolSet): Record<string, any> | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return { mode: "AUTO" };
  if (value === "none") return { mode: "NONE" };
  if (value === "required") return { mode: "ANY" };
  if (value && ["function", "custom"].includes(value.type) && typeof value.name === "string") {
    const tool = tools.get(value.namespace, value.name);
    if (!tool || tool.kind !== value.type) throw new BridgeError("The selected tool is not available on the Gemini backend.");
    return { mode: "ANY", allowedFunctionNames: [tool.flatName] };
  }
  throw new BridgeError("Unsupported Gemini tool_choice.");
}

export function buildGeminiRequest(context: BackendContext): { body: Record<string, any>; tools: ToolSet; continuationBefore?: string } {
  const request = normalizeToolDeclarations(context.request);
  const { route } = context;
  const tools = buildToolSet(request.tools);
  const system = request.instructions ? [{ text: request.instructions }] : [];
  const contents: Content[] = [];
  let entries: Entry[] = [];
  const calls = new Map<string, { name: string; id?: string }>();
  const callOrder = new Map<string, number>();
  const resultOrder = new Map<Part, number>();
  const flushModel = () => {
    if (entries.length) contents.push({ role: "model", parts: entries.flatMap(entry => entry.parts) });
    entries = [];
  };
  const appendUser = (parts: Part[]) => {
    if (!parts.length) return;
    flushModel();
    const last = contents.at(-1);
    if (last?.role === "user") last.parts.push(...parts);
    else contents.push({ role: "user", parts });
  };
  for (const item of prepareHistory(request.input, route)) {
    if (isOpaqueStateItem(item)) {
      entries.push({ parts: [item] });
    } else if (item.type === "bridge_reasoning") {
      const state = item.state.data as NativeParts;
      if (!object(state) || !Array.isArray(state.parts) || !state.parts.length || !state.parts.every(object)) {
        throw new BridgeError("Invalid Gemini reasoning carrier.");
      }
      if (state.projection) {
        const previous = entries.at(-1);
        const projection = state.projection;
        const matches = previous?.projection?.type === projection.type &&
          (projection.type === "message"
            ? textOf(previous.parts) === textOf(state.parts)
            : projection.type === "function_call" && typeof projection.call_id === "string" &&
              previous.projection.call_id === projection.call_id &&
              previous.parts[0]?.functionCall?.name === state.parts[0]?.functionCall?.name &&
              (previous.custom
                ? previous.parts[0]?.functionCall?.args?.input === state.parts[0]?.functionCall?.args?.input
                : isDeepStrictEqual(previous.parts[0]?.functionCall?.args, state.parts[0]?.functionCall?.args ?? {})));
        if (!matches) throw new BridgeError("Gemini reasoning does not match its preceding message or tool call.");
        entries.pop();
        if (projection.type === "function_call") {
          const call = state.parts[0]?.functionCall;
          if (state.parts.length !== 1 || !object(call) || typeof call.name !== "string") {
            throw new BridgeError("Invalid Gemini tool reasoning carrier.");
          }
          calls.set(projection.call_id!, { name: call.name, ...(typeof call.id === "string" ? { id: call.id } : {}) });
        }
      }
      if (state.continuation_before !== undefined) {
        if (typeof state.continuation_before !== "string" || !state.continuation_before.length) {
          throw new BridgeError("Invalid Gemini continuation boundary.");
        }
        appendUser([{ text: state.continuation_before }]);
      }
      entries.push({ parts: state.parts });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const wire = toolCallForReplay(item, tools);
      const call = { name: wire.name, id: wire.id, args: item.type === "custom_tool_call" ? { input: item.input } : parseArguments(item.arguments) };
      calls.set(item.call_id, { name: wire.name, id: wire.id });
      callOrder.set(item.call_id, callOrder.size);
      // This provisional import marker is replaced by the original signed part
      // when a matching native carrier follows. Foreign histories have no signature.
      entries.push({ parts: [{ functionCall: call, thoughtSignature: IMPORTED_SIGNATURE }], projection: { type: "function_call", call_id: item.call_id }, custom: item.type === "custom_tool_call" });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const wire = toolResultForReplay(item);
      const call = calls.get(item.call_id);
      if (!call) throw new BridgeError("Gemini tool output has no matching function call.");
      const parts = contentParts(wire.output);
      const media = parts.filter(part => part.inlineData || part.fileData);
      const result = { functionResponse: {
        ...call, response: { [wire.isError ? "error" : "output"]: textOf(parts) },
        ...(media.length ? { parts: media } : {}),
      } };
      resultOrder.set(result, callOrder.get(item.call_id)!);
      appendUser([result]);
    } else if (item.type === "message" || item.role) {
      const parts = contentParts(item.content);
      if (item.role === "system" || item.role === "developer") {
        if (parts.some(part => typeof part.text !== "string")) throw new BridgeError("Gemini system messages must contain text.");
        if (!contents.length && !entries.length) system.push(...parts as { text: string }[]);
        else appendUser([{ text: `<system-reminder>\n${parts.map(part => part.text).join("\n\n")}\n</system-reminder>` }]);
      } else if (item.role === "assistant") {
        if (parts.length) entries.push({ parts, projection: { type: "message" } });
      } else if (item.role === "user") appendUser(parts);
      else throw new BridgeError(`Unsupported Gemini role: ${String(item.role)}.`);
    } else throw new BridgeError(`Unsupported Gemini history item: ${String(item.type)}.`);
  }
  flushModel();
  // Gemini requires parallel responses in the corresponding call order.
  // Keep text/media and all other message boundaries in their original place.
  for (const content of contents) {
    if (content.role !== "user") continue;
    for (let index = 0; index < content.parts.length;) {
      if (!resultOrder.has(content.parts[index])) { index++; continue; }
      let end = index + 1;
      while (end < content.parts.length && resultOrder.has(content.parts[end])) end++;
      const ordered = content.parts.slice(index, end).sort((a, b) => resultOrder.get(a)! - resultOrder.get(b)!);
      content.parts.splice(index, end - index, ...ordered);
      index = end;
    }
  }
  const tail = contents.at(-1);
  const continuationBefore = tail?.role === "model" && !tail.parts.some(part => part.functionCall) ? "Continue." : undefined;
  if (continuationBefore) appendUser([{ text: continuationBefore }]);
  const generationConfig: Record<string, any> = {
    thinkingConfig: {
      thinkingLevel: reasoningEffort(route, request.reasoning?.effort).toUpperCase(),
      includeThoughts: reasoningSummaryRequested(request),
    },
  };
  const limit = request.max_output_tokens ?? route.profile.max_output_tokens;
  if (limit !== undefined) generationConfig.maxOutputTokens = limit;
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.top_p !== undefined) generationConfig.topP = request.top_p;
  const format = request.text?.format;
  if (format && format.type !== "text" && !context.compacting) {
    if (!["json_schema", "json_object"].includes(format.type)) throw new BridgeError(`Unsupported Gemini text format: ${String(format.type)}.`);
    generationConfig.responseMimeType = "application/json";
    if (format.type === "json_schema") generationConfig.responseJsonSchema = format.schema;
  }
  const choice = toolChoice(request.tool_choice, tools);
  const body: Record<string, any> = {
    generationConfig,
    ...(choice ? { toolConfig: { functionCallingConfig: choice } } : {}),
    ...route.upstream.options, ...route.config.options,
    contents,
  };
  // Merge generation options once: native values own supplied fields, while
  // required thinking defaults survive an unrelated temperature override.
  body.generationConfig = { ...generationConfig, ...route.upstream.options?.generationConfig as object, ...route.config.options?.generationConfig as object };
  if (context.compacting) {
    delete body.generationConfig.responseMimeType;
    delete body.generationConfig.responseSchema;
    delete body.generationConfig.responseJsonSchema;
    // Newer native endpoints expose the same structured-output constraint here.
    delete body.generationConfig.responseFormat;
  }
  if (system.length) body.systemInstruction = { parts: system };
  else delete body.systemInstruction;
  if (tools.entries.length) body.tools = [{ functionDeclarations: tools.entries.map(tool => ({
    name: tool.flatName, description: tool.description, parametersJsonSchema: tool.parameters,
  })) }];
  else delete body.tools;
  return { body, tools, continuationBefore };
}

function count(value: unknown, optional = false): number {
  if (optional && value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BridgeError("Gemini stream has invalid or missing token usage.", "upstream_error", 502);
  }
  return value;
}

function readUsage(value: any): Usage {
  return {
    input_tokens: count(value.promptTokenCount) + count(value.toolUsePromptTokenCount, true),
    output_tokens: count(value.candidatesTokenCount, true) + count(value.thoughtsTokenCount, true),
    cached_tokens: count(value.cachedContentTokenCount, true),
    reasoning_tokens: count(value.thoughtsTokenCount, true),
  };
}

export const runGemini: Backend = async (context, writer) => {
  const { body, tools, continuationBefore } = buildGeminiRequest(context);
  const model = context.route.config.model.replace(/^models\//, "");
  const response = await upstreamFetch(context.route, `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, body,
    context.signal, context.requestHeaders, undefined, context.fetch);
  context.onAccepted?.(response.headers);
  if (!response.body) throw new BridgeError("Gemini returned an empty stream.", "upstream_error", 502);
  let segment: Part[] = [];
  let thinking = false;
  let calls = 0;
  let visible = false;
  let finish: string | undefined;
  let finalCandidate: any;
  let rawUsage: Record<string, any> | undefined;
  const ids = new Set<string>();
  let pendingContinuation = continuationBefore;
  const carrier = (parts: Part[], projection?: Projection) => {
    const encoded = encodeReasoning({
      source: context.route.origin, format: context.route.profile.reasoning_format,
      data: { parts, ...(projection ? { projection } : {}),
        ...(pendingContinuation ? { continuation_before: pendingContinuation } : {}) } satisfies NativeParts,
    });
    pendingContinuation = undefined;
    return encoded;
  };
  const flush = (final = false) => {
    if (!segment.length) return;
    const text = textOf(segment);
    if (!thinking && text) writer.closeMessage(final ? "final_answer" : "commentary");
    writer.endReasoning(carrier(segment, !thinking && text ? { type: "message" } : undefined));
    segment = [];
  };
  try {
    for await (const { json } of parseJsonSse(response.body)) {
      context.signal.throwIfAborted();
      if (json.error) throw upstreamError(Number.isInteger(json.error.code) ? json.error.code : undefined, json, response.headers);
      if (json.promptFeedback?.blockReason) {
        throw new BridgeError(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}.`, "invalid_prompt", 400, undefined, { upstream: { body: json } });
      }
      if (json.usageMetadata) rawUsage = json.usageMetadata;
      for (const candidate of json.candidates ?? []) {
        if ((candidate.index ?? 0) !== 0 || json.candidates.length !== 1) {
          throw new BridgeError("Gemini returned more than one candidate.", "upstream_error", 502);
        }
        if (candidate.finishReason) { finish = candidate.finishReason; finalCandidate = candidate; }
        for (const raw of candidate.content?.parts ?? []) {
          if (!object(raw)) throw new BridgeError("Gemini returned an invalid content part.", "upstream_error", 502);
          const part = structuredClone(raw);
          if (part.functionCall) {
            flush();
            const value = part.functionCall;
            if (!object(value) || !object(value.args ?? {}) || typeof value.name !== "string") {
              throw new BridgeError("Gemini returned an invalid function call.", "upstream_error", 502);
            }
            const id = value.id ?? newId("call");
            if (typeof id !== "string" || !id || ids.has(id)) throw new BridgeError("Gemini returned an invalid or repeated function call ID.", "upstream_error", 502);
            ids.add(id);
            const call = prepareToolCall(tools, id, value.name, value.args ?? {});
            writeToolCall(writer, call);
            writer.endReasoning(carrier([part], { type: "function_call", call_id: call.call.call_id }));
            calls++;
          } else if (typeof part.text === "string" || typeof part.thoughtSignature === "string") {
            const isThinking = part.thought === true;
            if (segment.length && isThinking !== thinking) flush();
            thinking = isThinking;
            segment.push(part);
            if (isThinking) writer.reasoningDelta(part.text ?? "");
            else if (part.text) { writer.textDelta(part.text); visible = true; }
          } else throw new BridgeError("Gemini returned an unsupported content part.", "upstream_error", 502);
        }
      }
    }
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    throw transportError(error);
  }
  context.signal.throwIfAborted();
  if (!finish) throw new BridgeError("Gemini stream ended before a finishReason.", "upstream_error", 502);
  if (finish !== "STOP") {
    throw new BridgeError(`Gemini generation stopped with ${finish}${finalCandidate?.finishMessage ? `: ${finalCandidate.finishMessage}` : "."}`,
      "invalid_prompt", 400, undefined, { upstream: { body: finalCandidate } });
  }
  if (!rawUsage) throw new BridgeError("Gemini stream ended without token usage.", "upstream_error", 502);
  // Intermediate chunks can contain only routing metadata, not token counts.
  const usage = readUsage(rawUsage);
  if (!visible && !calls) throw new BridgeError("Gemini returned no text or tool calls.", "upstream_error", 502);
  flush(calls === 0);
  return { usage, endTurn: calls === 0 };
};
