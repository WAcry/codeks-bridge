import { encodeCompaction } from "./carrier.ts";
import type { CompactionCarrier, HandoffRecipe } from "./carrier.ts";
import { retainedCompactionHistory, splitCompactionPrefix } from "./compaction-history.ts";
import { BridgeError, ResponsesIncompleteError, ResponsesStreamError } from "./errors.ts";
import { newId } from "./ids.ts";
import { HANDOFF_PROMPT, SUMMARIZATION_PROMPT } from "./prompts.ts";
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

const HANDOFF_PARAMETERS = ["model", "instructions", "tools", "reasoning", "prompt_cache_key",
  "max_output_tokens", "service_tier", "parallel_tool_calls"] as const;

function handoffRecipe(context: BackendContext, prefix: Item[]): HandoffRecipe {
  const parameters = Object.fromEntries(HANDOFF_PARAMETERS
    .filter(key => context.request[key] !== undefined).map(key => [key, context.request[key]]));
  return structuredClone({ prefix, parameters, responsesLite: context.responsesLite === true }) as HandoffRecipe;
}

/** The same checkpoint-to-text request is used by eager and deferred handoffs. */
export function handoffRequest(recipe: HandoffRecipe, retained: Item[], checkpoint: Item): ResponsesRequest {
  const parameters = Object.fromEntries(HANDOFF_PARAMETERS
    .filter(key => recipe.parameters[key] !== undefined).map(key => [key, recipe.parameters[key]]));
  return {
    ...parameters,
    model: recipe.parameters.model,
    input: [...recipe.prefix, ...retained, checkpoint,
      { type: "message", role: "user", content: [{ type: "input_text", text: HANDOFF_PROMPT }] }],
    tool_choice: "none", stream: true,
  };
}

async function collect(context: BackendContext, backend: Backend): Promise<CollectedResponse> {
  const writer = new ResponseWriter({ write() {} }, { model: context.request.model, showSummary: false });
  let result;
  try {
    result = await backend(context, writer);
  } catch (cause) {
    // Auxiliary output and usage must not become the client's replacement history.
    if (cause instanceof ResponsesIncompleteError) {
      throw new BridgeError(cause.message, "invalid_prompt", 400, undefined, { upstream: { body: cause.response }, cause });
    }
    if (cause instanceof ResponsesStreamError && cause.response) {
      const { output: _output, usage: _usage, ...response } = cause.response;
      throw new ResponsesStreamError(cause.error, { ...response, output: [] }, cause.event);
    }
    throw cause;
  }
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

export async function collectHandoff(context: BackendContext, backend: Backend): Promise<{ summary: string; usage: Usage }> {
  // Generating text from the source's own native state is independent of whether
  // that route normally chooses to replay native checkpoints in ordinary turns.
  const route = { ...context.route, compaction: { ...context.route.compaction, native_replay: true } };
  const result = await collect({ ...context, route, compacting: true }, backend);
  return { summary: summaryText(result.output), usage: result.usage };
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
  const input = compactionInput(context.request);
  context.signal.throwIfAborted();
  const item = (carrier: CompactionCarrier) => ({
    type: "compaction", id: newId("cmp"), encrypted_content: encodeCompaction(carrier),
  });
  if (context.route.compaction.mode === "summary") {
    const result = await collect({ ...context, compacting: true, request: summaryRequest(context.request) }, backend);
    return { item: item({ summary: summaryText(result.output) }), usage: result.usage };
  }
  const native = await collect({
    ...context, compacting: true, request: { ...context.request, stream: true },
    // A later handoff may still return an HTTP error. Do not commit HTTP 200 yet.
    onAccepted: context.route.compaction.mode === "lazy" ? context.onAccepted : undefined,
  }, backend);
  const { prefix, history } = splitCompactionPrefix(input);
  const recipe = handoffRecipe(context, prefix);
  const carrier: CompactionCarrier = {
    native: { source: context.route.origin, format: context.route.profile.native_compaction_format!, data: nativeItem(native.output) },
    handoff: recipe,
  };
  const checkpoint = item(carrier);
  if (context.route.compaction.mode === "lazy") return { item: checkpoint, usage: native.usage };
  const summary = await collectHandoff({
    ...context, request: handoffRequest(recipe, retainedCompactionHistory(history), checkpoint),
  }, backend);
  return { item: item({ summary: summary.summary, native: carrier.native }), usage: combinedUsage(native.usage, summary.usage) };
}
