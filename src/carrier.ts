import type { ResponsesRequest, StateOrigin } from "./types.ts";

// Versioned, self-contained state stored in the client's encrypted_content field.
// These envelopes encode source facts and payloads, never replay policy.
const REASONING_PREFIX = "cxbr1:";
const COMPACTION_PREFIX = "cxbc1:";

export interface HandoffRecipe {
  prefix: Record<string, any>[];
  parameters: ResponsesRequest;
  responsesLite: boolean;
}

export interface StatePayload {
  source: StateOrigin;
  format: string;
  data: unknown;
}

export interface CompactionCarrier {
  /** The prompt-based summary. Any model can read it. */
  summary?: string;
  native?: StatePayload;
  /** Source request information needed to materialize a deferred summary. */
  handoff?: HandoffRecipe;
}

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statePayload(value: unknown): value is StatePayload {
  return object(value) && object(value.source) &&
    [value.source.id, value.source.connection, value.source.model, value.source.adapter, value.format]
      .every((field) => typeof field === "string" && field.length > 0) &&
    Object.hasOwn(value, "data") && value.data !== undefined;
}

function compactionCarrier(value: unknown): value is CompactionCarrier {
  if (!object(value) || (value.native !== undefined && !statePayload(value.native))) return false;
  if (value.summary !== undefined && (typeof value.summary !== "string" || !value.summary.trim())) return false;
  if (value.handoff !== undefined && (!object(value.handoff) ||
    !Array.isArray(value.handoff.prefix) || !value.handoff.prefix.every(object) ||
    !object(value.handoff.parameters) || typeof value.handoff.parameters.model !== "string" ||
    typeof value.handoff.responsesLite !== "boolean")) return false;
  return value.summary !== undefined || (value.native !== undefined && value.handoff !== undefined);
}

function encode(prefix: string, value: unknown): string {
  return prefix + Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: unknown, prefix: string): unknown {
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function encodeReasoning(state: StatePayload): string {
  if (!statePayload(state)) throw new TypeError("Invalid reasoning state envelope");
  return encode(REASONING_PREFIX, state);
}

export function decodeReasoning(value: unknown): StatePayload | undefined {
  const decoded = decode(value, REASONING_PREFIX);
  return statePayload(decoded) ? decoded : undefined;
}

export function encodeCompaction(carrier: CompactionCarrier): string {
  if (!compactionCarrier(carrier)) throw new TypeError("Invalid compaction state envelope");
  return encode(COMPACTION_PREFIX, carrier);
}

export function decodeCompaction(value: unknown): CompactionCarrier | undefined {
  const decoded = decode(value, COMPACTION_PREFIX);
  return compactionCarrier(decoded) ? decoded : undefined;
}
