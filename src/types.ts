import type { ResponseWriter, Usage } from "./writer.ts";
import type { ChatgptAuthConfig } from "./chatgpt-auth.ts";

export type Api = "responses" | "anthropic" | "chat";
export type AdapterId = "gpt-responses" | "claude-messages" | "deepseek-chat";
export type UnrecognizedStatePolicy = "passthrough" | "drop" | "error";
export interface ClaudeMessagesOptions {
  thinking_mismatch: "drop_block" | "error" | "upstream_default";
}
/** Bridge behavior, distinct from native request-body options. */
export interface AdapterConfig {
  "claude-messages"?: Partial<ClaudeMessagesOptions>;
}
export interface UpstreamConfig {
  /** ChatGPT subscription auth supplies its native endpoint by default. */
  base_url?: string;
  auth?: ChatgptAuthConfig;
  api_key_env?: string;
  /** An argv array. The command writes a short-lived credential to stdout. */
  api_key_command?: string[];
  auth_header?: string;
  /** Defaults to stream_idle_timeout_ms; null disables the wait-for-headers timer. */
  headers_timeout_ms?: number | null;
  stream_idle_timeout_ms?: number | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  adapters?: AdapterConfig;
}
export interface ModelConfig {
  upstream: string;
  model: string;
  catalog: string;
  /** Include this alias in the client catalog. Defaults to true. */
  expose?: boolean;
  /** Picker visibility; hidden aliases retain their catalog metadata. Defaults to list. */
  visibility?: "list" | "hide";
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: ("text" | "image")[];
  reasoning?: { default_effort?: string; effort_map?: Record<string, string> };
  replay?: { reasoning_from?: string[]; native_compaction_from?: string[]; unrecognized?: UnrecognizedStatePolicy };
  compaction?: { mode?: "summary" | "native"; model?: string; native_replay?: boolean };
  options?: Record<string, unknown>;
  adapters?: AdapterConfig;
}
export interface BridgeConfig {
  host?: string;
  port?: number;
  token_env?: string;
  request_max_mib?: number;
  compaction_cache_dir?: string;
  /** Optional subscription search connection, shared by all working models. */
  web_search?: { upstream: string };
  /** Optional subscription image connection, shared by all working models. */
  image_generation?: { upstream: string };
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
  replay: { reasoning: ReadonlySet<string>; native_compaction: ReadonlySet<string>; unrecognized: UnrecognizedStatePolicy };
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
export interface BridgeServerOptions {
  /** Used by model calls, standalone search and ChatGPT token refreshes. */
  fetch?: typeof globalThis.fetch;
  /** Runs once before Responses routing. Return a replacement or change the request in place. */
  transformRequest?: (request: ResponsesRequest, context: { headers: Headers }) =>
    ResponsesRequest | void | Promise<ResponsesRequest | void>;
  /** Observes committed client response events, including non-streaming responses. */
  onResponseEvent?: (request: ResponsesRequest, event: Record<string, any>) => void;
}
export interface BackendContext {
  request: ResponsesRequest;
  route: ResolvedModel;
  signal: AbortSignal;
  /** Client metadata; transport framing and credentials are replaced upstream. */
  requestHeaders?: Headers;
  fetch?: typeof globalThis.fetch;
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
