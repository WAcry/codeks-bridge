import { encodeReasoning } from "../carrier.ts";
import { BridgeError, ResponsesIncompleteError, responsesStreamError } from "../errors.ts";
import { prepareHistory } from "../history.ts";
import { reasoningEffort } from "../profiles.ts";
import { parseJsonSse } from "../sse.ts";
import { upstreamFetch } from "../upstream.ts";
import type { Backend, BackendContext } from "../types.ts";
import type { Usage } from "../writer.ts";

/** Replay complete content, never a server-side item reference. */
export function responsesBody({ request, route, compacting }: BackendContext): Record<string, any> {
  if (request.previous_response_id) {
    throw new BridgeError("previous_response_id is unsupported; send the complete conversation items");
  }
  const input = prepareHistory(request.input, route).map((item) => {
    // An assistant message id can reference a reasoning item that was filtered
    // during a model switch or an agent fork. Full content needs neither id.
    delete item.id;
    if (item.type === "bridge_reasoning") {
      if (typeof item.state.data !== "string") throw new BridgeError("Invalid Responses reasoning data.");
      return { type: "reasoning", summary: item.summary, encrypted_content: item.state.data };
    }
    return item;
  });
  const body: Record<string, any> = {
    ...(route.profile.max_output_tokens ? { max_output_tokens: route.profile.max_output_tokens } : {}),
    ...request,
    reasoning: { ...request.reasoning, effort: reasoningEffort(route, request.reasoning?.effort) },
    ...route.upstream.options,
    ...route.config.options,
    model: route.config.model,
    input,
    tools: request.tools,
    store: false,
    stream: true,
  };
  body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"])];
  delete body.previous_response_id;
  if (input.some((item) => item.type === "compaction_trigger")) {
    // Native compaction has its own output budget requirements. An ordinary
    // response limit can be smaller than its provider-enforced minimum.
    delete body.max_output_tokens;
  } else if (compacting) {
    delete body.text;
  }
  return body;
}

function usageFrom(value: any): Usage {
  const count = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new BridgeError(`Missing or invalid Responses usage field: ${field}`, "upstream_error", 502);
    }
    return value;
  };
  // These fields are required by codeks when their enclosing objects exist.
  count(value?.total_tokens, "total_tokens");
  const cached = value?.input_tokens_details == null ? undefined
    : count(value.input_tokens_details.cached_tokens, "input_tokens_details.cached_tokens");
  const reasoning = value?.output_tokens_details == null ? undefined
    : count(value.output_tokens_details.reasoning_tokens, "output_tokens_details.reasoning_tokens");
  const cacheWrite = value?.input_tokens_details?.cache_write_tokens;
  if (value?.codex_rollout_budget_units != null && !Number.isFinite(value.codex_rollout_budget_units)) {
    throw new BridgeError("Invalid Responses usage field: codex_rollout_budget_units", "upstream_error", 502);
  }
  return {
    input_tokens: count(value?.input_tokens, "input_tokens"),
    output_tokens: count(value?.output_tokens, "output_tokens"),
    ...(cached !== undefined ? { cached_tokens: cached } : {}),
    ...(cacheWrite !== undefined ? { cache_write_tokens: count(cacheWrite, "input_tokens_details.cache_write_tokens") } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
  };
}

/** Validate the client terminal contract before any buffered tools can run. */
function completedUsage(response: Record<string, any>): Usage {
  const invalid = (field: string): never => {
    throw new BridgeError(`Missing or invalid Responses completed field: ${field}`, "upstream_error", 502);
  };
  if (typeof response.id !== "string") invalid("id");
  if (response.end_turn != null && typeof response.end_turn !== "boolean") invalid("end_turn");
  const metadata = response.usage_metadata;
  if (metadata != null) {
    if (typeof metadata !== "object" || Array.isArray(metadata)) invalid("usage_metadata");
    if (metadata.amount != null && typeof metadata.amount !== "string") invalid("usage_metadata.amount");
  }
  return usageFrom(response.usage);
}

/** Transform only bridge-owned fields; native events keep their original shape. */
export const runResponses: Backend = async (context, writer) => {
  writer.useNativeResponses();
  const response = await upstreamFetch(context.route, "/responses", responsesBody(context), context.signal, context.requestHeaders,
    context.responsesLite ? { "x-openai-internal-codex-responses-lite": "true" } : undefined);
  context.onAccepted?.(response.headers);
  const states = new Map<number, { item: Record<string, any>; added: boolean; done: boolean }>();
  const phases = new Map<number, string>();
  let pendingPhase: { index: number; item: Record<string, any> } | undefined;
  let held: Record<string, any>[] = [];

  function itemFor(item: Record<string, any>, index: number): Record<string, any> {
    const result = { ...item };
    if (item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content) {
      result.encrypted_content = encodeReasoning({
        source: context.route.origin, format: context.route.profile.reasoning_format, data: item.encrypted_content,
      });
    }
    if (item.type === "function_call") {
      if (item.encrypted_function_args?.length) {
        throw new BridgeError("Encrypted tool arguments are unsupported; use plaintext client tools");
      }
      result.encrypted_function_args ??= [];
    }
    if (item.type === "message" && item.phase === undefined) {
      const phase = phases.get(index) ?? states.get(index)?.item.phase;
      if (phase !== undefined) result.phase = phase;
    }
    return result;
  }

  function responseFor(value: Record<string, any>): Record<string, any> {
    return {
      ...value, model: context.request.model,
      ...(Array.isArray(value.output) ? { output: value.output.map(itemFor) } : {}),
    };
  }

  function releasePhase(phase?: string): void {
    if (pendingPhase && phase !== undefined) {
      pendingPhase.item.phase = phase;
      phases.set(pendingPhase.index, phase);
    }
    pendingPhase = undefined;
    const events = held;
    held = [];
    for (const event of events) writer.nativeEvent(event);
  }

  function emit(event: Record<string, any>): void {
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const index = event.output_index ?? 0;
      if (pendingPhase && index !== pendingPhase.index && event.item.type !== "reasoning") releasePhase("commentary");
      if (event.type === "response.output_item.done" && event.item.type === "message" && event.item.phase === undefined) {
        pendingPhase = { index, item: event.item };
      }
    }
    if (pendingPhase) held.push(event);
    else writer.nativeEvent(event);
  }

  function outputEvent(event: Record<string, any>): void {
    const index = event.output_index ?? 0;
    const item = itemFor(event.item, index);
    const state = states.get(index) ?? { item, added: false, done: false };
    if (event.type === "response.output_item.done" && !state.added) {
      emit({ type: "response.output_item.added", output_index: index, item });
      state.added = true;
    }
    state.item = item;
    state.added ||= event.type === "response.output_item.added";
    state.done ||= event.type === "response.output_item.done";
    states.set(index, state);
    emit({ ...event, item });
  }

  function reconcileOutput(result: Record<string, any>): void {
    // codeks persists item events, not the terminal response.output. This also
    // applies to partial history returned only by an incomplete terminal event.
    for (const [index, item] of (result.output ?? []).entries()) {
      if (!states.get(index)?.done) outputEvent({ type: "response.output_item.done", output_index: index, item });
    }
  }

  function terminal(event: Record<string, any>): { usage: Usage; endTurn: boolean } {
    const result = event.response;
    if (event.type === "response.failed" || result?.status === "failed" || result?.error) {
      releasePhase();
      throw responsesStreamError(responseFor(result), response.headers, event);
    }
    if (event.type === "response.incomplete" || result?.status === "incomplete") {
      reconcileOutput(result);
      releasePhase();
      throw new ResponsesIncompleteError(responseFor(result), event);
    }
    if (result?.status !== "completed") {
      throw new BridgeError("The upstream did not return a completed response", "stream_error", 502);
    }
    const usage = completedUsage(result);
    reconcileOutput(result);
    for (const state of states.values()) {
      if (!state.done) throw new BridgeError("The upstream completed with an unfinished output item", "stream_error", 502);
    }
    const hasCalls = [...states.values()].some(({ item }) => ["function_call", "custom_tool_call"].includes(item.type));
    const endTurn = result.end_turn ?? !hasCalls;
    if (pendingPhase) {
      releasePhase(result.output?.[pendingPhase.index]?.phase ?? (endTurn ? "final_answer" : "commentary"));
    }
    writer.nativeEvent({ ...event, response: { ...responseFor(result), end_turn: endTurn } });
    return { usage, endTurn };
  }

  if (response.headers.get("content-type")?.includes("application/json")) {
    const result = await response.json() as Record<string, any>;
    if (result.status === "completed" || result.status === "incomplete") {
      writer.nativeEvent({ type: "response.created", response: { ...result, model: context.request.model, status: "in_progress", output: [] } });
    }
    return terminal({ type: result.status === "incomplete" ? "response.incomplete" : "response.completed", response: result });
  }
  if (!response.body) throw new BridgeError("The upstream returned an empty response", "stream_error", 502);
  for await (const { json: event } of parseJsonSse(response.body)) {
    switch (event.type) {
      case "response.output_item.added":
      case "response.output_item.done":
        outputEvent(event);
        break;
      case "response.completed":
      case "response.failed":
      case "response.incomplete":
        return terminal(event);
      case "error":
        releasePhase();
        throw responsesStreamError(event.error ?? event, response.headers, event);
      default:
        emit(event.response ? { ...event, response: responseFor(event.response) } : event);
    }
  }
  throw new BridgeError("The upstream stream ended before response.completed", "stream_error", 502);
};
