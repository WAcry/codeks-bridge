import { BridgeError } from "./errors.ts";
import type { StateOrigin } from "./types.ts";

// Versioned, self-contained state stored in the client's encrypted_content field.
// These envelopes encode source facts and payloads, never replay policy.
const REASONING_PREFIX = "cxbr2:";
const COMPACTION_PREFIX = "cxbc2:";

export interface StatePayload {
  source: StateOrigin;
  format: string;
  data: unknown;
}

export interface CompactionCarrier {
  /** The prompt-based summary. Any model can read it. */
  summary: string;
  native?: StatePayload;
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
  return object(value) && typeof value.summary === "string" && !!value.summary.trim() &&
    (value.native === undefined || statePayload(value.native));
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
  if (typeof value !== "string" || !value.startsWith(REASONING_PREFIX)) return undefined;
  const decoded = decode(value, REASONING_PREFIX);
  if (!statePayload(decoded)) throw new BridgeError("Malformed bridge reasoning state envelope");
  return decoded;
}

export function encodeCompaction(carrier: CompactionCarrier): string {
  if (!compactionCarrier(carrier)) throw new TypeError("Invalid compaction state envelope");
  return encode(COMPACTION_PREFIX, carrier);
}

export function decodeCompaction(value: unknown): CompactionCarrier | undefined {
  const decoded = decode(value, COMPACTION_PREFIX);
  return compactionCarrier(decoded) ? decoded : undefined;
}
