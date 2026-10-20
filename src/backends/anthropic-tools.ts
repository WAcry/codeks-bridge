import { BridgeError } from "../errors.ts";
import { buildToolSet, normalizeToolDeclarations, type ToolEntry, type ToolSet } from "../tools.ts";
import type { ResponsesRequest } from "../types.ts";

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function definition(tool: ToolEntry): AnthropicToolDefinition {
  return { name: tool.flatName, description: tool.description, input_schema: tool.parameters };
}

/** Keep later definitions at their original conversation boundary. */
export function buildAnthropicTools(request: ResponsesRequest, mode: "inline" | "top_level"): {
  tools: ToolSet;
  definitions: AnthropicToolDefinition[];
  input: ResponsesRequest["input"];
} {
  if (mode === "top_level") {
    const normalized = normalizeToolDeclarations(request);
    const tools = buildToolSet(normalized.tools);
    return { tools, definitions: tools.entries.map(definition), input: normalized.input };
  }

  const tools = buildToolSet(request.tools);
  const initial = new Map(tools.entries.map((tool) => [tool.flatName, definition(tool)]));
  if (!Array.isArray(request.input)) {
    return { tools, definitions: [...initial.values()], input: request.input };
  }

  const input: Record<string, any>[] = [];
  let prefix = true;
  for (const item of request.input) {
    if (item?.type === "additional_tools") {
      if (!Array.isArray(item.tools)) throw new BridgeError("additional_tools requires a tools array.");
      const definitions = tools.add(item.tools).map(definition);
      if (prefix) {
        for (const tool of definitions) initial.set(tool.name, tool);
      } else if (definitions.length) {
        input.push({ ...item, tools: definitions });
      }
    } else {
      input.push(item);
      if (!item || !["system", "developer"].includes(item.role) ||
        (item.type !== undefined && item.type !== "message")) prefix = false;
    }
  }
  return { tools, definitions: [...initial.values()], input };
}
