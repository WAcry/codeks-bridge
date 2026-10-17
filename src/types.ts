import type { CompactionReplay } from "./compaction-replay.ts";
import type { ResponseWriter, Usage } from "./writer.ts";

export type Api = "responses" | "anthropic" | "chat";
export interface UpstreamConfig {
  api: Api;
  base_url: string;
  api_key_env?: string;
  /** An argv array. The command writes a short-lived credential to stdout. */
  api_key_command?: string[];
  auth_header?: string;
  stream_idle_timeout_ms?: number;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
}
export interface ModelConfig {
  upstream: string;
  model: string;
  context_window?: number;
  max_output_tokens?: number;
  options?: Record<string, unknown>;
}
export interface BridgeConfig {
  host?: string;
  port?: number;
  token_env?: string;
  upstreams: Record<string, UpstreamConfig>;
  models: Record<string, ModelConfig>;
}
export interface ResolvedModel {
  slug: string;
  config: ModelConfig;
  upstream: UpstreamConfig;
  /** Identifies the upstream configuration, endpoint, API, and actual model, never a display alias. */
  key: string;
}
export interface ResponsesRequest {
  model: string;
  input?: string | Record<string, any>[];
  instructions?: string;
  tools?: any[];
  tool_choice?: any;
  reasoning?: { effort?: string; summary?: string; [key: string]: unknown };
  stream?: boolean;
  [key: string]: any;
}
export interface BackendContext {
  request: ResponsesRequest;
  route: ResolvedModel;
  signal: AbortSignal;
  compacting?: boolean;
  compactionReplay?: CompactionReplay;
}
export interface BackendResult {
  usage: Usage;
  endTurn?: boolean;
}
export type Backend = (context: BackendContext, writer: ResponseWriter) => Promise<BackendResult>;
