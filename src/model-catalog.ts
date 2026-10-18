import { readFileSync } from "node:fs";
import { BridgeError } from "./errors.ts";
import type { AdapterId } from "./types.ts";

export interface CatalogEntry {
  source: { repository: string; tag: string; commit: string; path: string; model: string };
  adjustments: string[];
  adapter: AdapterId;
  effort_map?: Record<string, string>;
  max_output_tokens?: number;
  model: Record<string, any>;
}

export const catalogKeys = [
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol",
  "claude-opus-5-5", "claude-sonnet-5-5", "deepseek-flash",
] as const;

const entries = new Map<string, CatalogEntry>(catalogKeys.map(key => [
  key, JSON.parse(readFileSync(new URL(`../catalog/${key}.json`, import.meta.url), "utf8")) as CatalogEntry,
]));

/** Each alias gets its own copy of the reviewed entry. */
export function getCatalogEntry(key: string): CatalogEntry {
  const entry = entries.get(key);
  if (!entry) throw new BridgeError(`Unknown catalog model: ${key}`);
  return structuredClone(entry);
}
