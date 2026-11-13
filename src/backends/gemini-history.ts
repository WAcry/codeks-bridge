import { BridgeError } from "../errors.ts";

type Item = Record<string, any>;
export interface GeminiProjection { type: "message" | "function_call"; call_id?: string }
export interface GeminiParts {
  parts: Item[];
  projection?: GeminiProjection;
  continuation_before?: string;
  generation?: string;
}
interface Unit { items: Item[]; state?: GeminiParts; callId?: string }
const isCall = (item: Item) => ["function_call", "custom_tool_call"].includes(item.type);
const isResult = (item: Item) => ["function_call_output", "custom_tool_call_output"].includes(item.type);
const isBoundary = (item: Item) => !isCall(item) && !isResult(item) &&
  item.type !== "bridge_reasoning" && item.role !== "assistant";

function stateOf(item: Item): GeminiParts | undefined {
  if (item.type !== "bridge_reasoning") return undefined;
  const state = item.state.data;
  if (!state || !Array.isArray(state.parts) || !state.parts.length ||
      !state.parts.every((part: any) => part && typeof part === "object" && !Array.isArray(part))) {
    throw new BridgeError("Invalid Gemini reasoning carrier.");
  }
  if (state.generation !== undefined && (typeof state.generation !== "string" || !state.generation.length)) {
    throw new BridgeError("Invalid Gemini reasoning generation.");
  }
  return state;
}

/** Associate native state before generic tool normalization can split it. */
function associate(items: Item[], checkpointCalls: Set<string>): Unit[] {
  const calls = new Map<string, Item[]>();
  for (const item of items) if (isCall(item)) {
    const matches = calls.get(item.call_id) ?? [];
    matches.push(item);
    calls.set(item.call_id, matches);
  }
  const attached = new Map<Item, Item>();
  const consumed = new Set<Item>();
  for (const [index, item] of items.entries()) {
    const state = stateOf(item);
    if (state?.projection?.type !== "function_call") continue;
    const id = state.projection.call_id;
    if (typeof id !== "string" || !id) throw new BridgeError("Invalid Gemini tool reasoning projection.");
    const matches = calls.get(id) ?? [];
    if (!matches.length && state.generation !== undefined && !checkpointCalls.has(id) && items.slice(index + 1).every(isResult)) {
      // A snapshot can stop after state was committed but before its tool item.
      // State alone never creates a call or a synthetic result.
      consumed.add(item);
      continue;
    }
    if (matches.length !== 1 || attached.has(matches[0])) {
      throw new BridgeError("Gemini tool reasoning has no unique matching call in this history segment.");
    }
    const callIndex = items.indexOf(matches[0]);
    if (!items.slice(Math.min(index, callIndex) + 1, Math.max(index, callIndex)).every(isResult)) {
      throw new BridgeError("Gemini tool reasoning crosses another assistant item.");
    }
    attached.set(matches[0], item);
    consumed.add(item);
  }
  const units: Unit[] = [];
  for (const item of items) {
    if (consumed.has(item)) continue;
    const carrier = attached.get(item);
    if (carrier) {
      units.push({ items: [item, carrier], state: stateOf(carrier), callId: item.call_id });
      continue;
    }
    const state = stateOf(item);
    const previous = units.at(-1);
    if (state?.projection?.type === "message" && previous?.items.length === 1 && previous.items[0].role === "assistant") {
      previous.items.push(item);
      previous.state = state;
    } else units.push({ items: [item], ...(state ? { state } : {}) });
  }
  return units;
}

/** Restore the observed prefix of each native response, then its tool results. */
function group(units: Unit[]): Item[] {
  const output: Item[] = [];
  let native: Unit[] = [];
  let results: Item[] = [];
  let generation: string | undefined;
  let legacyCalls = false;
  const flush = () => {
    output.push(...native.flatMap(unit => unit.items), ...results);
    native = [];
    results = [];
    generation = undefined;
    legacyCalls = false;
  };
  for (const unit of units) {
    const item = unit.items[0];
    if (native.length && isResult(item)) {
      results.push(item);
      continue;
    }
    const state = unit.state;
    const sameGeneration = state?.generation !== undefined && state.generation === generation;
    // Old carriers have no generation ID. For the supported native models,
    // unsigned calls following a signed call belong to that parallel step.
    const legacyParallel = legacyCalls && state?.generation === undefined && unit.callId !== undefined &&
      state?.parts.length === 1 && state.parts[0].functionCall && state.parts[0].thoughtSignature === undefined;
    const legacyTail = legacyCalls && state?.generation === undefined && !state?.projection &&
      state?.parts.every(part => part.text === "" && part.thought !== true && !part.functionCall);
    if (!state || state.continuation_before !== undefined || (!sameGeneration && !legacyParallel && !legacyTail)) flush();
    if (state?.generation !== undefined || unit.callId !== undefined || legacyTail) {
      native.push(unit);
      generation = state?.generation;
      if (unit.callId !== undefined) {
        legacyCalls ||= state?.generation === undefined && typeof state?.parts[0]?.thoughtSignature === "string";
      }
    } else output.push(...unit.items);
  }
  flush();
  return output;
}

/** Called independently for each compaction epoch after source filtering. */
export function prepareGeminiHistory(items: Item[]): Item[] {
  const checkpointCalls = new Set(items.filter(isCall).map(item => item.call_id));
  const output: Item[] = [];
  let segment: Item[] = [];
  const flush = () => { output.push(...group(associate(segment, checkpointCalls))); segment = []; };
  for (const item of items) {
    if (isBoundary(item)) { flush(); output.push(item); }
    else segment.push(item);
  }
  flush();
  return output;
}
