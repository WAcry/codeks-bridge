import { encodeCompaction } from "./carrier.ts";
import { BridgeError } from "./errors.ts";
import { newId } from "./ids.ts";
import { SUMMARIZATION_PROMPT } from "./prompts.ts";
import type { Backend, BackendContext, ResponsesRequest } from "./types.ts";
import { ResponseWriter } from "./writer.ts";
import type { Usage } from "./writer.ts";

type Item = Record<string, any>;

interface CollectedResponse {
  output: readonly unknown[];
  usage: Usage;
}

export interface CompactionResult {
  item: Record<string, unknown>;
  usage: Usage;
}

export function isCompactionRequest(request: ResponsesRequest): boolean {
  return Array.isArray(request.input) && request.input.some((item) => item.type === "compaction_trigger");
}

function compactionInput(request: ResponsesRequest): Item[] {
  if (!Array.isArray(request.input)) throw new BridgeError("Compaction requires an input array.");
  const triggers = request.input.filter((item) => item.type === "compaction_trigger");
  if (triggers.length !== 1 || request.input.at(-1)?.type !== "compaction_trigger") {
    throw new BridgeError("Compaction requires exactly one trigger at the end of input.");
  }
  return request.input.slice(0, -1);
}

/** Keep the shared prefix intact, including tools and any signed reasoning. */
export function summaryRequest(request: ResponsesRequest): ResponsesRequest {
  const input = compactionInput(request);
  const result: ResponsesRequest = {
    ...request,
    input: [...input, { type: "message", role: "user", content: [{ type: "input_text", text: SUMMARIZATION_PROMPT }] }],
    stream: true,
    tool_choice: "none",
  };
  // A conversation's structured output schema does not describe a handoff summary.
  delete result.text;
  return result;
}

async function collect(context: BackendContext, backend: Backend): Promise<CollectedResponse> {
  const writer = new ResponseWriter({ write() {} }, { model: context.request.model, showSummary: false });
  const result = await backend(context, writer);
  context.signal.throwIfAborted();
  writer.complete(result.usage);
  if (result.endTurn === false) throw new BridgeError("Compaction did not finish its response.");
  return { output: writer.outputItems, usage: result.usage };
}

function summaryText(output: readonly unknown[]): string {
  const parts: string[] = [];
  for (const value of output) {
    const item = value as Item;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      throw new BridgeError("Compaction returned a tool call instead of a summary.");
    }
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === "refusal") throw new BridgeError("Compaction was refused.");
      if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  const summary = parts.join("\n").trim();
  if (!summary) throw new BridgeError("Compaction returned an empty summary.");
  return summary;
}

function nativeItem(output: readonly unknown[]): Record<string, unknown> {
  const items = output.filter((value) => {
    const item = value as Item;
    return item.type === "compaction" || item.type === "compaction_summary";
  }) as Item[];
  if (items.length !== 1 || typeof items[0]?.encrypted_content !== "string" || !items[0].encrypted_content) {
    throw new BridgeError("Native compaction must return exactly one nonempty compaction item.");
  }
  return items[0];
}

function combinedUsage(first: Usage, second?: Usage): Usage {
  if (!second) return first;
  const result: Usage = {
    input_tokens: first.input_tokens + second.input_tokens,
    output_tokens: first.output_tokens + second.output_tokens,
  };
  for (const field of ["cached_tokens", "cache_write_tokens", "reasoning_tokens"] as const) {
    if (first[field] !== undefined || second[field] !== undefined) result[field] = (first[field] ?? 0) + (second[field] ?? 0);
  }
  return result;
}

/** Publish one checkpoint only when every required representation is complete. */
export async function compact(context: BackendContext, backend: Backend): Promise<CompactionResult> {
  const prompt = summaryRequest(context.request);
  context.signal.throwIfAborted();
  const cancel = new AbortController();
  const signal = AbortSignal.any([context.signal, cancel.signal]);
  let pendingAcceptance = context.route.compaction.mode === "dual" ? 2 : 1;
  const shared = { ...context, compacting: true, signal, onAccepted: (headers?: Headers) => {
    if (--pendingAcceptance === 0 && !signal.aborted) {
      context.onAccepted?.(context.route.compaction.mode === "summary" ? headers : undefined);
    }
  } };
  const run = async <T>(request: ResponsesRequest, decode: (output: readonly unknown[]) => T) => {
    try {
      const result = await collect({ ...shared, request }, backend);
      return { value: decode(result.output), usage: result.usage };
    } catch (error) {
      cancel.abort(error);
      throw error;
    }
  };
  // Both requests read the same original history. Neither receives the other's output.
  const summaryPromise = run(prompt, summaryText);
  const nativePromise = context.route.compaction.mode === "dual"
    ? run({ ...context.request, stream: true }, nativeItem)
    : Promise.resolve(undefined);
  const results = await Promise.allSettled([summaryPromise, nativePromise]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw signal.reason ?? failure.reason;
  signal.throwIfAborted();
  const summary = (results[0] as PromiseFulfilledResult<Awaited<typeof summaryPromise>>).value;
  const native = (results[1] as PromiseFulfilledResult<Awaited<typeof nativePromise>>).value;
  return {
    item: {
      type: "compaction",
      id: newId("cmp"),
      encrypted_content: encodeCompaction({
        summary: summary.value,
        ...(native ? { native: {
          source: context.route.origin,
          format: context.route.profile.native_compaction_format!,
          data: native.value,
        } } : {}),
      }),
    },
    usage: combinedUsage(summary.usage, native?.usage),
  };
}
