// Tool definitions for upstreams that only know plain functions.
//
// codeks sends three kinds of client tools: `function`, `custom` (freeform
// input, optionally constrained by a Lark or regex grammar) and `namespace`
// (a group of functions). The shared Messages/Chat mapping uses names matching
// [a-zA-Z0-9_-]{1,64}, the smaller Chat limit. See docs/tools.md.

import { createHash } from "node:crypto";
import { BridgeError } from "./errors.ts";
import type { ResponsesRequest } from "./types.ts";

export const MAX_TOOL_NAME = 64;

export interface ToolEntry {
  /** Name sent to the upstream. */
  flatName: string;
  kind: "function" | "custom";
  name: string;
  namespace?: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolSet {
  entries: ToolEntry[];
  /** Upstream name -> tool. */
  byFlat: Map<string, ToolEntry>;
  /** Upstream name for a call found in history. */
  flatFor(namespace: string | undefined, name: string): string;
  /** Looks up the original identity, including codeks' default namespace. */
  get(namespace: string | undefined, name: string): ToolEntry | undefined;
  /** Resolves a call made by the upstream model. */
  resolve(flatName: string): ToolEntry | undefined;
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned === "" ? "tool" : cleaned;
}

function shorten(name: string, limit: number): string {
  if (name.length <= limit) return name;
  // Same idea as codeks for long MCP tool names: keep a readable prefix and
  // add a short hash so that different long names stay different.
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, limit - 9)}_${hash}`;
}

/** Joins a namespace and a tool name the way codeks names MCP tools. */
export function baseFlatName(namespace: string | undefined, name: string): string {
  let joined = name;
  if (namespace) joined = namespace.endsWith("_") ? `${namespace}${name}` : `${namespace}__${name}`;
  return shorten(sanitize(joined), MAX_TOOL_NAME);
}

function identity(namespace: string | undefined, name: string): string {
  return `${namespace === "functions" ? "" : namespace ?? ""}\u0000${name}`;
}

/** Extracts Lite declarations for APIs whose tools live outside the conversation. */
export function normalizeToolDeclarations(request: ResponsesRequest): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  const tools = [...(request.tools ?? [])];
  const input = request.input.filter((item) => {
    if (item?.type !== "additional_tools") return true;
    if (!Array.isArray(item.tools)) throw new BridgeError("additional_tools requires a tools array.");
    tools.push(...item.tools);
    return false;
  });
  return { ...request, input, tools };
}

const SCHEMA_CHILD_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_CHILD_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_CHILD_ONE = ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"];

/** Removes keywords that only the OpenAI Responses API understands. */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "encrypted" && typeof value === "boolean") continue;
    if (SCHEMA_CHILD_MAPS.includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) mapped[k] = cleanSchema(v);
      out[key] = mapped;
    } else if (SCHEMA_CHILD_LISTS.includes(key) && Array.isArray(value)) {
      out[key] = value.map(cleanSchema);
    } else if (SCHEMA_CHILD_ONE.includes(key)) {
      out[key] = cleanSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function objectSchema(parameters: unknown): Record<string, unknown> {
  const cleaned = cleanSchema(parameters);
  if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
    const schema = cleaned as Record<string, unknown>;
    if (schema.type === "object" || schema.properties) return { type: "object", ...schema };
  }
  return { type: "object", properties: {} };
}

/** Describes a custom tool's input format in words, for function-only upstreams. */
export function customToolDescription(description: string, format: any): string {
  const parts = [description.trim()];
  parts.push("Pass the whole tool input as the string field `input`.");
  if (format && format.type === "grammar" && typeof format.definition === "string") {
    const syntax = String(format.syntax ?? "lark");
    if (syntax === "regex") {
      parts.push(`The \`input\` string must match this regular expression:\n\n\`\`\`\n${format.definition}\n\`\`\``);
    } else {
      parts.push(`The \`input\` string must match this ${syntax === "lark" ? "Lark" : syntax} grammar:\n\n\`\`\`${syntax}\n${format.definition}\n\`\`\``);
    }
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

const CUSTOM_PARAMETERS = {
  type: "object",
  properties: { input: { type: "string", description: "The raw tool input." } },
  required: ["input"],
  additionalProperties: false,
};

export function buildToolSet(tools: unknown[] | undefined): ToolSet {
  const entries: ToolEntry[] = [];
  const byFlat = new Map<string, ToolEntry>();
  const byIdentity = new Map<string, ToolEntry>();

  const add = (entry: Omit<ToolEntry, "flatName">) => {
    const id = identity(entry.namespace, entry.name);
    const previous = byIdentity.get(id);
    if (previous) {
      // Lite updates contain only changed members. Replace that definition
      // without losing siblings or changing its established upstream name.
      Object.assign(previous, entry);
      return;
    }
    let flatName = baseFlatName(entry.namespace, entry.name);
    // Add a suffix only when two different tools would get the same name.
    for (let n = 2; byFlat.has(flatName); n++) {
      const suffix = `_${n}`;
      flatName = baseFlatName(entry.namespace, entry.name).slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    }
    const full = { ...entry, flatName };
    entries.push(full);
    byFlat.set(flatName, full);
    byIdentity.set(id, full);
  };

  const visit = (tool: any, namespace: string | undefined) => {
    if (!tool || typeof tool !== "object") return;
    if (tool.type === "function") {
      add({
        kind: "function",
        name: String(tool.name),
        namespace,
        description: String(tool.description ?? ""),
        parameters: objectSchema(tool.parameters),
      });
    } else if (tool.type === "custom") {
      add({
        kind: "custom",
        name: String(tool.name),
        namespace,
        description: customToolDescription(String(tool.description ?? ""), tool.format),
        parameters: CUSTOM_PARAMETERS,
      });
    } else if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) visit(inner, String(tool.name));
    }
    // Hosted tools (web_search, image_generation, tool_search, ...) have no
    // equivalent on these upstreams and are left out.
  };

  for (const tool of tools ?? []) visit(tool, undefined);

  return {
    entries,
    byFlat,
    flatFor(namespace, name) {
      return byIdentity.get(identity(namespace, name))?.flatName ?? baseFlatName(namespace, name);
    },
    get(namespace, name) {
      return byIdentity.get(identity(namespace, name));
    },
    resolve(flatName) {
      return byFlat.get(flatName);
    },
  };
}

/** Upstream tool call ids must match [a-zA-Z0-9_-]{1,64} on some APIs. */
export function safeCallId(id: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id;
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 8);
  return `${sanitize(id).slice(0, 55)}_${hash}`;
}
