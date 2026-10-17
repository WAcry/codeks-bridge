import { decodeReasoning, encodeReasoning } from "../carrier.ts";
import { BridgeError } from "../errors.ts";
import { prepareHistory } from "../history.ts";
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
    if (item.type === "reasoning") {
      item.encrypted_content = decodeReasoning(item.encrypted_content)!.payload;
      delete item.content;
    }
    return item;
  });
  const body: Record<string, any> = {
    ...(route.config.max_output_tokens ? { max_output_tokens: route.config.max_output_tokens } : {}),
    ...request,
    ...route.upstream.options,
    ...route.config.options,
    model: route.config.model,
    input,
    store: false,
    stream: true,
    include: [...new Set([...(Array.isArray(request.include) ? request.include : []), "reasoning.encrypted_content"])],
  };
  delete body.previous_response_id;
  if (input.some((item) => item.type === "compaction_trigger")) {
    // Native compaction has its own output budget requirements. An ordinary
    // response limit can be smaller than its provider-enforced minimum.
    delete body.max_output_tokens;
  } else if (compacting) {
    body.tool_choice = "none";
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
  const cached = value?.input_tokens_details?.cached_tokens;
  const reasoning = value?.output_tokens_details?.reasoning_tokens;
  return {
    input_tokens: count(value?.input_tokens, "input_tokens"),
    output_tokens: count(value?.output_tokens, "output_tokens"),
    ...(cached !== undefined ? { cached_tokens: count(cached, "input_tokens_details.cached_tokens") } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: count(reasoning, "output_tokens_details.reasoning_tokens") } : {}),
  };
}

function responseError(response: any): BridgeError {
  const error = response?.error ?? response;
  const code = typeof error?.code === "string" ? error.code : "stream_error";
  return new BridgeError(String(error?.message ?? "The upstream response failed"), code, 502, error?.headers);
}

interface ItemState {
  item: Record<string, any>;
  text: string;
  summary: string;
  done: boolean;
}

export const runResponses: Backend = async (context, writer) => {
  const response = await upstreamFetch(context.route, "/responses", responsesBody(context), context.signal);
  const states = new Map<number, ItemState>();
  const byId = new Map<string, ItemState>();
  const calls: Record<string, any>[] = [];

  function stateFor(event: any): ItemState {
    const index = Number(event.output_index ?? 0);
    let state = event.item_id ? byId.get(event.item_id) : states.get(index);
    if (!state) {
      state = { item: event.item ?? {}, text: "", summary: "", done: false };
      states.set(index, state);
    }
    if (event.item?.id) byId.set(event.item.id, state);
    return state;
  }

  function finishItem(item: any, state: ItemState): void {
    if (state.done) return;
    state.done = true;
    state.item = item;
    switch (item.type) {
      case "reasoning": {
        const summary = (item.summary ?? []).filter((part: any) => part.type === "summary_text")
          .map((part: any) => part.text ?? "").join("\n\n");
        if (!state.summary && summary) writer.reasoningDelta(summary);
        const content = typeof item.encrypted_content === "string" && item.encrypted_content
          ? encodeReasoning(context.route.key, item.encrypted_content) : undefined;
        writer.endReasoning(content, summary || state.summary);
        break;
      }
      case "message": {
        const content = Array.isArray(item.content) ? item.content : [];
        if (content.some((part: any) => part.type === "refusal")) {
          throw new BridgeError("The upstream refused the request", "invalid_prompt");
        }
        const text = content.filter((part: any) => part.type === "output_text")
          .map((part: any) => part.text ?? "").join("");
        if (!text.startsWith(state.text)) throw new BridgeError("The upstream changed already streamed text", "stream_error", 502);
        writer.textDelta(text.slice(state.text.length));
        writer.closeMessage();
        break;
      }
      case "function_call":
      case "custom_tool_call":
        calls.push(item);
        break;
      case "compaction":
      case "compaction_summary":
        // The compaction coordinator wraps this native item only after both
        // the native request and the portable summary request have succeeded.
        writer.addItem(item);
        break;
      default:
        throw new BridgeError(`Unsupported upstream output item: ${String(item.type)}`);
    }
  }

  function finishResponse(result: any): { usage: Usage; endTurn: boolean } {
    if (result?.status === "failed" || result?.error) throw responseError(result);
    if (result?.status === "incomplete") {
      throw new BridgeError(`The upstream response is incomplete: ${String(result.incomplete_details?.reason ?? "unknown")}`, "invalid_prompt");
    }
    if (result?.status !== "completed") {
      throw new BridgeError("The upstream did not return a completed response", "stream_error", 502);
    }
    const usage = usageFrom(result.usage);
    for (const [index, item] of (result.output ?? []).entries()) {
      const state = (item.id && byId.get(item.id)) || states.get(index) || stateFor({ output_index: index, item });
      finishItem(item, state);
    }
    for (const state of states.values()) {
      if (!state.done) throw new BridgeError("The upstream completed with an unfinished output item", "stream_error", 502);
    }
    for (const call of calls) {
      if (call.type === "function_call") {
        if (call.encrypted_function_args?.length) {
          throw new BridgeError("Encrypted tool arguments are unsupported; use plaintext client tools");
        }
        writer.addFunctionCall({
          call_id: call.call_id,
          namespace: call.namespace,
          name: call.name,
          arguments: call.arguments,
        });
      } else {
        writer.addCustomToolCall({ call_id: call.call_id, namespace: call.namespace, name: call.name, input: call.input });
      }
    }
    return { usage, endTurn: result.end_turn ?? calls.length === 0 };
  }

  if (response.headers.get("content-type")?.includes("application/json")) {
    return finishResponse(await response.json());
  }
  if (!response.body) throw new BridgeError("The upstream returned an empty response", "stream_error", 502);
  for await (const { json: event } of parseJsonSse(response.body)) {
    switch (event.type) {
      case "response.output_item.added":
        stateFor(event);
        break;
      case "response.reasoning_summary_text.delta": {
        const state = stateFor(event);
        state.summary += String(event.delta ?? "");
        writer.reasoningDelta(String(event.delta ?? ""));
        break;
      }
      case "response.output_text.delta": {
        const state = stateFor(event);
        state.text += String(event.delta ?? "");
        writer.textDelta(String(event.delta ?? ""));
        break;
      }
      case "response.output_item.done":
        finishItem(event.item, stateFor(event));
        break;
      case "response.completed":
        return finishResponse(event.response);
      case "response.failed":
      case "error":
        throw responseError(event.response ?? event.error ?? event);
      case "response.incomplete":
        throw new BridgeError(`The upstream response is incomplete: ${String(event.response?.incomplete_details?.reason ?? "unknown")}`, "invalid_prompt");
    }
  }
  throw new BridgeError("The upstream stream ended before response.completed", "stream_error", 502);
};
