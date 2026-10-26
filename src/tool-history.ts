import { BridgeError } from "./errors.ts";

type Item = Record<string, any>;

const isCall = (item: Item) => ["function_call", "custom_tool_call"].includes(item.type);
const isResult = (item: Item) => ["function_call_output", "custom_tool_call_output"].includes(item.type);
const isCheckpoint = (item: Item) => ["compaction", "compaction_summary"].includes(item.type);
const isUser = (item: Item) => (item.type === "message" || !item.type) && item.role === "user";
const isReminder = (item: Item) =>
  item.type === "additional_tools" ||
  ((item.type === "message" || !item.type) && ["user", "developer", "system"].includes(item.role));

function toolName(item: Item): string {
  return JSON.stringify({ ...(item.namespace ? { namespace: item.namespace } : {}), name: item.name });
}

function notification(item: Item, label: string): Item {
  const content = typeof item.output === "string"
    ? [{ type: "input_text", text: item.output }]
    : item.output;
  if (!Array.isArray(content)) throw new BridgeError("Tool output must be text or a content array.");
  return {
    type: "message", role: "user",
    content: [{ type: "input_text", text: `${label}:\n` }, ...content],
  };
}

/** Translate Responses notifications without rewriting an earlier tool result. */
function notifications(items: readonly Item[]): Item[] {
  const calls = new Map<string, Item>();
  const answered = new Set<string>();
  return items.map((item) => {
    if (isCall(item) && typeof item.call_id === "string") calls.set(item.call_id, item);
    if (!isResult(item)) return item;
    if (item.type === "function_call_output" && item.call_id == null && typeof item.name === "string") {
      return notification(item, `Tool notification from ${toolName(item)}`);
    }
    if (typeof item.call_id !== "string") return item;
    if (answered.has(item.call_id)) {
      const call = calls.get(item.call_id);
      return notification(item, `Additional output from tool call ${JSON.stringify(item.call_id)}${call ? ` ${toolName(call)}` : ""}`);
    }
    answered.add(item.call_id);
    return item;
  });
}

/** Repair only existing results within one checkpoint segment. */
function translateSegment(items: readonly Item[]): Item[] {
  const normalized = notifications(items);
  const results = new Map<string, number>();
  const calls = new Set<string>();
  const repeatedCalls = new Set<string>();
  const nextUser: number[] = [];
  let boundary = normalized.length;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const item = normalized[index];
    nextUser[index] = boundary;
    if (isUser(item)) boundary = index;
    if (typeof item.call_id !== "string") continue;
    if (isResult(item)) results.set(item.call_id, index);
    if (isCall(item)) {
      if (calls.has(item.call_id)) repeatedCalls.add(item.call_id);
      calls.add(item.call_id);
    }
  }
  const output: Item[] = [];
  const moved = new Set<number>();
  let batch: Item[] = [];
  const pending = new Set<string>();
  let answering = false;
  for (const [index, item] of normalized.entries()) {
    if (moved.has(index)) continue;
    if (answering && (isCall(item) || item.role === "assistant" || item.type === "bridge_reasoning")) {
      // Responses can start another assistant step while older calls are still
      // running. Chat/Messages cannot: move their real results forward rather
      // than merging assistant steps or inventing an interrupted result.
      // A user boundary or a reused call ID makes this repair ambiguous.
      const late = [...pending].map((id) => repeatedCalls.has(id) ? undefined : results.get(id));
      const complete = !batch.some(isUser) && late.every((position) =>
        position !== undefined && position > index && position < nextUser[index] && !moved.has(position));
      if (complete) {
        for (const position of (late as number[]).sort((a, b) => a - b)) {
          batch.push(normalized[position]);
          moved.add(position);
        }
        output.push(...batch.filter((part) => !isReminder(part)), ...batch.filter(isReminder));
      } else output.push(...batch);
      batch = [];
      pending.clear();
      answering = false;
    }
    if (isCall(item) && typeof item.call_id === "string") pending.add(item.call_id);
    if (!pending.size) {
      output.push(item);
      continue;
    }
    batch.push(item);
    if (isResult(item) && pending.delete(item.call_id)) answering = true;
    if (!pending.size) {
      output.push(...batch.filter((part) => !isReminder(part)), ...batch.filter(isReminder));
      batch = [];
      answering = false;
    }
  }
  // Leave incomplete exchanges alone; never invent calls or results.
  return [...output, ...batch];
}

/** Keep tool exchanges adjacent without borrowing results across checkpoints. */
export function translateToolHistory(items: readonly Item[]): Item[] {
  const output: Item[] = [];
  let segment: Item[] = [];
  for (const item of items) {
    if (isCheckpoint(item)) {
      output.push(...translateSegment(segment), item);
      segment = [];
    } else segment.push(item);
  }
  return [...output, ...translateSegment(segment)];
}
