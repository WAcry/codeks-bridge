import type { ResponseWriter, Usage } from "./writer.ts";

export type Api = "responses" | "anthropic" | "chat";
export type AdapterId = "gpt-responses" | "claude-messages" | "deepseek-chat";
export interface UpstreamConfig {
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
  catalog: string;
  /** Include this alias in the client catalog. Defaults to true. */
  expose?: boolean;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: ("text" | "image")[];
  reasoning?: { default_effort?: string; effort_map?: Record<string, string> };
  replay?: { reasoning_from?: string[]; native_compaction_from?: string[] };
  compaction?: { mode?: "summary" | "native"; model?: string; native_replay?: boolean };
  options?: Record<string, unknown>;
}
export interface BridgeConfig {
  host?: string;
  port?: number;
  token_env?: string;
  compaction_cache_dir?: string;
  /** Debug capture for the /inspect/ page. */
  inspect?: { capture?: boolean; max_mib?: number };
  upstreams: Record<string, UpstreamConfig>;
  models: Record<string, ModelConfig>;
}
export interface ModelProfile {
  model_info: Record<string, any>;
  max_output_tokens?: number;
  id: AdapterId;
  api: Api;
  reasoning_format: string;
  native_compaction_format?: string;
  default_effort: string;
  multi_agent_effort?: string;
  effort_map: Record<string, string>;
  input_modalities: ("text" | "image")[];
}
export interface StateOrigin {
  /** Stable source fingerprint, independent of aliases and replay policy. */
  id: string;
  connection: string;
  model: string;
  adapter: AdapterId;
}
export interface ResolvedModel {
  slug: string;
  config: ModelConfig;
  upstream: UpstreamConfig;
  profile: ModelProfile;
  origin: StateOrigin;
  replay: { reasoning: ReadonlySet<string>; native_compaction: ReadonlySet<string> };
  compaction: { mode: "summary" | "native"; native_replay: boolean };
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
  /** Client metadata; transport framing and credentials are replaced upstream. */
  requestHeaders?: Headers;
  compacting?: boolean;
  /** Transport mode received from the client, including tool-free Lite requests. */
  responsesLite?: boolean;
  /** Called after the upstream accepts the HTTP request, before consuming its body. */
  onAccepted?: (headers?: Headers) => void;
}
export interface BackendResult {
  usage: Usage;
  endTurn?: boolean;
}
export type Backend = (context: BackendContext, writer: ResponseWriter) => Promise<BackendResult>;
