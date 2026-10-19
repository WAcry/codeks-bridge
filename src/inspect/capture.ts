// In-memory capture of complete exchanges for the inspector. A capture keeps
// every byte the bridge received and sent. Only credential header values are
// redacted; bodies are never filtered.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { BridgeConfig, ResolvedModel, ResponsesRequest } from "../types.ts";

const MIB = 1024 * 1024;
export const DEFAULT_CAPTURE_MIB = 256;

export type EndKind = "active" | "complete" | "cancelled" | "error" | "unread";
export type HeaderMap = Record<string, string>;
export interface Part { t: number; text: string }

interface Scope { exchange?: Exchange; label?: string }
const scope = new AsyncLocalStorage<Scope>();

// Segment match keeps diagnostics such as x-ratelimit-remaining-tokens visible.
const SENSITIVE = /(^|[-_])(auth|authorization|token|secret|password|passwd|cookie|key|apikey|credential|credentials|signature)([-_]|$)/i;

function redact(name: string, value: string, extra: ReadonlySet<string>): string {
  if (!extra.has(name) && !SENSITIVE.test(name)) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `[redacted: ${value.length} chars, sha256 ${digest}]`;
}

/** Lowercase names, join repeated values, and redact credentials. */
export function headerMap(
  headers: Headers | IncomingHttpHeaders | OutgoingHttpHeaders | undefined,
  extra: ReadonlySet<string> = new Set(),
): HeaderMap {
  const result: HeaderMap = {};
  if (!headers) return result;
  const entries: [string, unknown][] = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [rawName, rawValue] of entries) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.map(String).join(name === "set-cookie" ? "\n" : ", ") : String(rawValue);
    result[name] = redact(name, value, extra);
  }
  return result;
}

function byteLength(chunk: Uint8Array | string): number {
  return typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One HTTP message after its start line: status, headers, and timed body parts. */
export class Message {
  status?: number;
  statusText?: string;
  headers?: HeaderMap;
  headersMs?: number;
  endedMs?: number;
  end: EndKind = "active";
  error?: string;
  readonly parts: Part[] = [];
  bytes = 0;
  private readonly decoder = new TextDecoder();
  private readonly exchange: Exchange;
  constructor(exchange: Exchange) { this.exchange = exchange; }

  head(status: number, statusText: string | undefined, headers: HeaderMap): void {
    if (this.exchange.closed) return;
    if (this.headersMs === undefined) this.exchange.touch();
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
    this.headersMs ??= this.exchange.now();
  }

  push(chunk: Uint8Array | string): void {
    if (this.exchange.closed || this.end !== "active") return;
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text) this.parts.push({ t: this.exchange.now(), text });
    const size = byteLength(chunk);
    this.bytes += size;
    this.exchange.account(size);
  }

  finish(end: Exclude<EndKind, "active">, error?: unknown): void {
    if (this.exchange.closed || this.end !== "active") return;
    const rest = this.decoder.decode();
    if (rest) this.parts.push({ t: this.exchange.now(), text: rest });
    this.end = end;
    if (error !== undefined) this.error = message(error);
    this.endedMs = this.exchange.now();
    this.exchange.touch();
  }

  text(): string {
    return this.parts.map(part => part.text).join("");
  }

  discard(): void {
    this.parts.length = 0;
    this.bytes = 0;
    this.headers = undefined;
    this.error = undefined;
    this.decoder.decode();
  }
}

/** One request from the bridge to an upstream. */
export class Call {
  readonly index: number;
  readonly label: string;
  readonly startedMs: number;
  readonly method = "POST";
  readonly url: string;
  readonly headers: HeaderMap;
  text: string;
  bytes: number;
  error?: string;
  response?: Message;
  private readonly exchange: Exchange;

  constructor(exchange: Exchange, label: string, url: string, headers: HeaderMap, text: string) {
    this.exchange = exchange;
    this.index = exchange.calls.length;
    this.label = label;
    this.startedMs = exchange.now();
    this.url = url;
    this.headers = headers;
    this.text = text;
    this.bytes = Buffer.byteLength(text);
    exchange.account(this.bytes);
    exchange.touch();
  }

  received(response: Response): void {
    if (this.response || this.exchange.closed) return;
    this.response = new Message(this.exchange);
    this.response.head(response.status, response.statusText, headerMap(response.headers));
  }

  chunk(value: Uint8Array): void {
    this.response?.push(value);
  }

  done(end: Exclude<EndKind, "active">, error?: unknown): void {
    this.response?.finish(end, error);
  }

  failed(error: unknown): void {
    if (this.exchange.closed || this.response || this.error !== undefined) return;
    this.error = message(error);
    this.exchange.touch();
  }

  discard(): void {
    this.text = "";
    this.bytes = 0;
    for (const name of Object.keys(this.headers)) delete this.headers[name];
    this.error = undefined;
    this.response?.discard();
  }
}

export interface RequestMeta {
  model: string | null;
  kind: "turn" | "compaction" | "invalid";
  stream: boolean | null;
  input_items: number | null;
  preview: string | null;
}

function previewOf(request: ResponsesRequest): string | null {
  if (typeof request.input === "string") return request.input.slice(0, 200);
  if (!Array.isArray(request.input)) return null;
  for (let i = request.input.length - 1; i >= 0; i--) {
    const item = request.input[i];
    // A subagent's task arrives as an agent_message item after the inherited user turns.
    const task = item?.type === "agent_message" || (item?.role === "user" && (item.type === undefined || item.type === "message"));
    if (!task) continue;
    const text = typeof item.content === "string" ? item.content
      : Array.isArray(item.content) ? item.content.filter((part: any) => typeof part?.text === "string").map((part: any) => part.text).join(" ") : "";
    if (text.trim()) return text.trim().replace(/\s+/g, " ").slice(0, 200);
  }
  return null;
}

/** One client request and everything it caused. */
export class Exchange {
  readonly id: string;
  readonly seq: number;
  rev = 0;
  readonly startedAt = Date.now();
  durationMs?: number;
  closed = false;
  readonly method: string;
  readonly path: string;
  readonly headers: HeaderMap;
  requestText?: string;
  requestBytes = 0;
  meta: RequestMeta = { model: null, kind: "invalid", stream: null, input_items: null, preview: null };
  route?: ResolvedModel;
  responsesLite?: boolean;
  readonly calls: Call[] = [];
  readonly response: Message;
  bytes = 0;
  readonly inspector: Inspector;
  private readonly t0 = performance.now();

  constructor(inspector: Inspector, seq: number, req: IncomingMessage, res: ServerResponse) {
    this.inspector = inspector;
    this.seq = seq;
    this.id = `x${seq}`;
    this.method = req.method ?? "";
    this.path = req.url ?? "";
    this.headers = headerMap(req.headers);
    this.response = new Message(this);
    this.tap(res);
  }

  now(): number { return Math.round((performance.now() - this.t0) * 10) / 10; }
  touch(): void { this.rev = ++this.inspector.rev; }
  account(bytes: number): void { this.inspector.account(this, bytes); }

  received(text: string): void {
    if (this.closed) return;
    this.requestText = text;
    this.requestBytes = Buffer.byteLength(text);
    this.account(this.requestBytes);
  }

  parsed(request: ResponsesRequest): void {
    if (this.closed) return;
    const input = request.input;
    this.meta = {
      model: typeof request.model === "string" ? request.model : null,
      kind: Array.isArray(input) && input.some(item => item?.type === "compaction_trigger") ? "compaction" : "turn",
      stream: typeof request.stream === "boolean" ? request.stream : null,
      input_items: Array.isArray(input) ? input.length : null,
      preview: previewOf(request),
    };
    this.touch();
  }

  routed(route: ResolvedModel, responsesLite: boolean): void {
    if (this.closed) return;
    this.route = route;
    this.responsesLite = responsesLite;
    this.touch();
  }

  /** Records what the bridge writes, at the same calls that write it. */
  private tap(res: ServerResponse): void {
    const exchange = this;
    const { writeHead, write, end } = res;
    const head = (target: ServerResponse, status: number, rest: any[]) => {
      const text = typeof rest[0] === "string" ? rest[0] : undefined;
      const extra = text === undefined ? rest[0] : rest[1];
      const given = Array.isArray(extra) ? Object.fromEntries(extra) : extra ?? {};
      exchange.response.head(status, text ?? target.statusMessage, headerMap({ ...target.getHeaders(), ...headerMap(given) }));
    };
    const chunk = (target: ServerResponse, value: unknown, encoding: unknown) => {
      if (exchange.response.headersMs === undefined) head(target, target.statusCode, []);
      if (typeof value === "string") exchange.response.push(typeof encoding === "string" && encoding !== "utf8" && encoding !== "utf-8" ? Buffer.from(value, encoding as BufferEncoding) : value);
      else if (value instanceof Uint8Array) exchange.response.push(value);
    };
    res.writeHead = function (this: ServerResponse, status: number, ...rest: any[]) {
      head(this, status, rest);
      return (writeHead as any).call(this, status, ...rest);
    } as typeof res.writeHead;
    res.write = function (this: ServerResponse, value: any, ...rest: any[]) {
      chunk(this, value, rest[0]);
      return (write as any).call(this, value, ...rest);
    } as typeof res.write;
    res.end = function (this: ServerResponse, ...args: any[]) {
      if (args.length && typeof args[0] !== "function") chunk(this, args[0], args[1]);
      return (end as any).apply(this, args);
    } as typeof res.end;
    res.once("close", () => this.close(res.writableFinished));
  }

  private close(finished: boolean): void {
    if (this.closed) return;
    this.response.finish(finished ? "complete" : "cancelled", finished ? undefined : "Client disconnected");
    for (const call of this.calls) {
      if (!call.response) call.failed(finished ? "No upstream response" : "Cancelled by client disconnect");
      // The bridge stops reading after the terminal event; any remaining bytes stay unread.
      else call.done(finished ? "unread" : "cancelled");
    }
    this.durationMs = this.now();
    this.closed = true;
    this.touch();
    this.inspector.evict();
  }

  /** Releases captured data without stopping the underlying HTTP exchange. */
  discard(): void {
    this.closed = true;
    this.requestText = undefined;
    this.requestBytes = 0;
    this.meta = { model: null, kind: "invalid", stream: null, input_items: null, preview: null };
    this.route = undefined;
    for (const name of Object.keys(this.headers)) delete this.headers[name];
    for (const call of this.calls) call.discard();
    this.calls.length = 0;
    this.response.discard();
    this.bytes = 0;
  }
}

/** Process-wide capture store. Nothing is kept unless capture is on. */
export class Inspector {
  capturing: boolean;
  readonly maxBytes: number;
  bytes = 0;
  evicted = 0;
  rev = 0;
  private seq = 0;
  readonly startedAt = Date.now();
  readonly exchanges = new Map<string, Exchange>();
  readonly config: BridgeConfig;
  private readonly redactions: ReadonlySet<string>;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.capturing = config.inspect?.capture ?? false;
    this.maxBytes = (config.inspect?.max_mib ?? DEFAULT_CAPTURE_MIB) * MIB;
    this.redactions = new Set(Object.values(config.upstreams).flatMap(up => up.auth_header ? [up.auth_header.toLowerCase()] : []));
  }

  /** Runs one server request with a slot for its exchange. */
  scope<T>(fn: () => T): T { return scope.run({}, fn); }

  begin(req: IncomingMessage, res: ServerResponse): Exchange | undefined {
    const slot = scope.getStore();
    if (!this.capturing || !slot) return undefined;
    const exchange = new Exchange(this, ++this.seq, req, res);
    this.exchanges.set(exchange.id, exchange);
    slot.exchange = exchange;
    exchange.touch();
    return exchange;
  }

  /** Records one upstream request made inside the current exchange. */
  upstream(url: string, headers: Headers, text: string): Call | undefined {
    const slot = scope.getStore();
    const exchange = slot?.exchange;
    if (!exchange || exchange.closed || this.exchanges.get(exchange.id) !== exchange) return undefined;
    const call = new Call(exchange, slot.label ?? "main", url, headerMap(headers, this.redactions), text);
    exchange.calls.push(call);
    return call;
  }

  account(exchange: Exchange, bytes: number): void {
    if (this.exchanges.get(exchange.id) !== exchange) return;
    exchange.bytes += bytes;
    this.bytes += bytes;
    this.evict();
  }

  /** Rechecks the soft cap when bytes arrive or an active exchange closes. */
  evict(): void {
    if (this.bytes <= this.maxBytes) return;
    // The cap is soft: exchanges still streaming are never evicted.
    for (const [id, candidate] of this.exchanges) {
      if (this.bytes <= this.maxBytes) break;
      if (!candidate.closed) continue;
      this.exchanges.delete(id);
      this.bytes -= candidate.bytes;
      this.evicted++;
    }
    this.rev++;
  }

  clear(): void {
    for (const exchange of this.exchanges.values()) exchange.discard();
    this.exchanges.clear();
    this.bytes = 0;
    this.rev++;
  }
}

/** Labels upstream calls made inside fn, such as the two compaction branches. */
export function withCaptureLabel<T>(label: string, fn: () => T): T {
  const slot = scope.getStore();
  return slot?.exchange ? scope.run({ ...slot, label }, fn) : fn();
}

/** Records an upstream request when the current server request is being captured. */
export function captureUpstream(url: string, headers: Headers, text: string): Call | undefined {
  return scope.getStore()?.exchange?.inspector.upstream(url, headers, text);
}
