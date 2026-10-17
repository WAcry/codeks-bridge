// Bridge-owned payloads stored in codeks history.
//
// codeks keeps reasoning items and compaction items in its history and sends
// them back on every request. The bridge puts its own envelope into their
// `encrypted_content` field so that it can tell, on later requests, which
// model produced the payload. See docs/reasoning.md and docs/compaction.md.
//
// Reasoning:  "cxbr1:" + b64url(key) + ":" + payload
// Compaction: "cxbc1:" + b64url(JSON CompactionCarrier)

const REASONING_PREFIX = "cxbr1:";
const COMPACTION_PREFIX = "cxbc1:";

export function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function b64urlDecode(text: string): string {
  return Buffer.from(text, "base64url").toString("utf8");
}

export interface ReasoningCarrier {
  key: string;
  payload: string;
}

/** The model identity is encoded; the payload is kept verbatim. */
export function encodeReasoning(key: string, payload: string): string {
  return `${REASONING_PREFIX}${b64urlEncode(key)}:${payload}`;
}

export function decodeReasoning(value: unknown): ReasoningCarrier | undefined {
  if (typeof value !== "string" || !value.startsWith(REASONING_PREFIX)) return undefined;
  const rest = value.slice(REASONING_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return undefined;
  try {
    return { key: b64urlDecode(rest.slice(0, sep)), payload: rest.slice(sep + 1) };
  } catch {
    return undefined;
  }
}

export function encodeJsonPayload(value: unknown): string {
  return b64urlEncode(JSON.stringify(value));
}

export function decodeJsonPayload<T>(payload: string): T | undefined {
  try {
    return JSON.parse(b64urlDecode(payload)) as T;
  } catch {
    return undefined;
  }
}

export interface CompactionCarrier {
  v: 1;
  /** The prompt-based summary. Any model can read it. */
  summary: string;
  /** The upstream's own compaction item, valid only for the same key. */
  native?: { key: string; item: Record<string, unknown> };
}

export function encodeCompaction(carrier: CompactionCarrier): string {
  return COMPACTION_PREFIX + b64urlEncode(JSON.stringify(carrier));
}

export function decodeCompaction(value: unknown): CompactionCarrier | undefined {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(b64urlDecode(value.slice(COMPACTION_PREFIX.length)));
    if (!parsed || parsed.v !== 1 || typeof parsed.summary !== "string" || !parsed.summary.trim()) return undefined;
    if (parsed.native !== undefined) {
      const native = parsed.native;
      if (!native || typeof native.key !== "string" || !native.key || !native.item ||
          typeof native.item !== "object" || Array.isArray(native.item) ||
          !["compaction", "compaction_summary"].includes(native.item.type) ||
          typeof native.item.encrypted_content !== "string" || !native.item.encrypted_content) return undefined;
    }
    return parsed as CompactionCarrier;
  } catch {
    // fall through
  }
  return undefined;
}
