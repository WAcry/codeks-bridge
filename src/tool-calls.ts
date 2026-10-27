import { createHash } from "node:crypto";
import { BridgeError } from "./errors.ts";
import type { ToolSet } from "./tools.ts";
import type { FunctionCallItem, CustomToolCallItem, ResponseWriter } from "./writer.ts";

// call_id survives codeks persistence and tool-result pairing. Keep only the
// original wire identity and a diagnostic, never credentials or session state.
const PREFIX = "cxbt1_";
const ERROR_NAMESPACE = "codeks_bridge_tool_error";
const ERROR_NAME = "invalid_call";

interface WireCall {
  id: string;
  name: string;
  error?: string;
}
export type ClientToolCall =
  | { kind: "function"; call: FunctionCallItem }
  | { kind: "custom"; call: CustomToolCallItem };

function decode(id: unknown): WireCall | undefined {
  if (typeof id !== "string" || !id.startsWith(PREFIX)) return;
  try {
    const value = JSON.parse(Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8"));
    if (value && typeof value.id === "string" && value.id && typeof value.name === "string" && value.name &&
        (value.error === undefined || typeof value.error === "string")) return value;
  } catch { /* Unrecognized ids remain opaque. */ }
}

/** Read only diagnostics explicitly recorded by the bridge, not tool-result text. */
export function toolCallDiagnostic(item: Record<string, any>): { name: string; message: string } | undefined {
  if (!["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(item.type)) return;
  const wire = decode(item.call_id);
  if (wire?.error !== undefined) return { name: wire.name, message: wire.error };
}

/** Resolve a model's name without changing the declared tool table. */
export function prepareToolCall(tools: ToolSet, id: string, name: string, args: Record<string, unknown>, argumentsText = JSON.stringify(args)): ClientToolCall {
  if (typeof id !== "string" || !id || typeof name !== "string" || !name) {
    throw new BridgeError("Upstream returned an incomplete tool call.", "upstream_error", 502);
  }
  const candidates = tools.candidates(name);
  const tool = candidates.length === 1 ? candidates[0] : undefined;
  let error: string | undefined;
  if (!tool) {
    const choices = (candidates.length ? candidates : tools.entries).map(tool => tool.flatName);
    error = `Tool name ${JSON.stringify(name)} is ${candidates.length ? "ambiguous" : "unknown"}. No tool was executed.` +
      (choices.length ? `\nCall one of these tools using its full name:\n${choices.map(choice => `- ${choice}`).join("\n")}` : "\nNo tools are available.");
    // This identity is deliberately absent from codeks. Never dispatch an
    // ambiguous bare name: it might accidentally select a default tool.
    if (tools.get(ERROR_NAMESPACE, ERROR_NAME)) {
      throw new BridgeError("The tool error namespace is reserved by the bridge.");
    }
  }
  const call_id = error || name !== tool?.flatName
    ? PREFIX + Buffer.from(JSON.stringify({ id, name, ...(error ? { error } : {}) })).toString("base64url")
    : id;
  if (!tool) return { kind: "function", call: {
    call_id, namespace: ERROR_NAMESPACE, name: ERROR_NAME, arguments: argumentsText,
  } };
  if (tool.kind === "custom") {
    if (typeof args.input !== "string") throw new BridgeError("A custom tool call has no string input.", "upstream_error", 502);
    return { kind: "custom", call: { call_id, name: tool.name, namespace: tool.namespace, input: args.input } };
  }
  return { kind: "function", call: { call_id, name: tool.name, namespace: tool.namespace, arguments: argumentsText } };
}

export function writeToolCall(writer: ResponseWriter, prepared: ClientToolCall): void {
  if (prepared.kind === "custom") writer.addCustomToolCall(prepared.call);
  else writer.addFunctionCall(prepared.call);
}

/** Restore the exact model-visible call name, including an accepted alias. */
export function toolCallForReplay(item: Record<string, any>, tools: ToolSet): { id: string; name: string } {
  const wire = decode(item.call_id);
  return wire ? { id: wire.id, name: wire.name } : { id: item.call_id, name: tools.flatFor(item.namespace, item.name) };
}

/** A failed dispatch becomes actionable feedback on the ordinary tool loop. */
export function toolResultForReplay(item: Record<string, any>): { id: string; output: unknown; isError: boolean } {
  const wire = decode(item.call_id);
  return { id: wire?.id ?? item.call_id, output: wire?.error ?? item.output, isError: wire?.error !== undefined };
}

/** Project tool history onto Responses without changing the client's stored identity. */
export function toolItemForResponses(item: Record<string, any>): Record<string, any> {
  if (!["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(item.type) ||
      typeof item.call_id !== "string") return item;
  const wire = item.type.endsWith("_output") ? decode(item.call_id) : undefined;
  if (item.call_id.length <= 64 && wire?.error === undefined) return item;
  // Responses limits call_id to 64 characters. Hash the complete client id,
  // not wire.id: distinct carriers can contain the same upstream id.
  const call_id = item.call_id.length > 64
    ? `call_${createHash("sha256").update(item.call_id).digest("base64url")}` : item.call_id;
  const output = wire?.error !== undefined ? { output: wire.error } : {};
  // Accepted aliases already have the correct Responses name/namespace/type.
  // Failed calls retain their non-executable identity and actionable feedback.
  return { ...item, call_id, ...output };
}
