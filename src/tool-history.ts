import { BridgeError } from "./errors.ts";

type Item = Record<string, any>;

const isCall = (item: Item) => ["function_call", "custom_tool_call"].includes(item.type);
const isResult = (item: Item) => ["function_call_output", "custom_tool_call_output"].includes(item.type);
const isReminder = (item: Item) =>
  (item.type === "message" || !item.type) && ["user", "developer", "system"].includes(item.role);

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

/** Keep a complete tool exchange together on APIs that require adjacent results. */
export function translateToolHistory(items: readonly Item[]): Item[] {
  const output: Item[] = [];
  let batch: Item[] = [];
  const pending = new Set<string>();
  let answering = false;
  for (const item of notifications(items)) {
    // A new assistant step does not repair an incomplete earlier exchange.
    if (answering && (isCall(item) || item.role === "assistant" || item.type === "bridge_reasoning")) {
      output.push(...batch);
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
