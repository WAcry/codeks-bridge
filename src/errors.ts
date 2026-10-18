export interface UpstreamFailure {
  status?: number;
  body: unknown;
}

/** Native Responses HTTP failures retain their transport-level meaning. */
export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;
  constructor(status: number, body: string, headers: Headers) {
    super(`Upstream returned HTTP ${status}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** A Responses failure belongs to the SSE protocol, not HTTP classification. */
export class ResponsesStreamError extends Error {
  readonly error: Record<string, unknown>;
  constructor(error: Record<string, unknown>) {
    super(typeof error.message === "string" ? error.message : "The upstream response failed");
    this.name = "ResponsesStreamError";
    this.error = error;
  }
}

/** Client retry classification is separate from the unmodified upstream failure. */
export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly upstream?: UpstreamFailure;
  constructor(message: string, code = "invalid_prompt", status = 400, headers?: Record<string, string>, options?: { upstream?: UpstreamFailure; cause?: unknown }) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
    this.headers = headers;
    this.upstream = options?.upstream;
  }
}

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" ? value : undefined;
}

function retryAfter(value: unknown): string | undefined {
  if (value instanceof Headers) return value.get("retry-after") ?? undefined;
  for (const [name, content] of Object.entries(record(value) ?? {})) {
    if (name.toLowerCase() === "retry-after" && (typeof content === "string" || typeof content === "number")) return String(content);
  }
  return undefined;
}

/** Keep native fields; only supplement missing retry advice from HTTP headers. */
export function responsesStreamError(payload: unknown, headers?: Headers): ResponsesStreamError {
  const error = record(record(payload)?.error ?? payload) ?? {};
  const delay = retryAfter(headers);
  if (delay !== undefined && retryAfter(error.headers) === undefined) {
    return new ResponsesStreamError({ ...error, headers: { ...record(error.headers), "retry-after": delay } });
  }
  return new ResponsesStreamError(error);
}

/** Translate non-Responses protocols into errors understood by the client. */
export function upstreamError(status: number | undefined, payload: unknown, headers?: Headers): BridgeError {
  const envelope = record(payload);
  const raw = envelope?.error ?? payload;
  const error = record(raw);
  const message = typeof error?.message === "string" ? error.message
    : typeof raw === "string" && raw.length ? raw
    : status !== undefined ? `Upstream returned HTTP ${status}` : "The upstream response failed";
  const kind = [error?.code, error?.type].filter((value) => typeof value === "string").join(" ");
  let code: string;
  if (/context_length|too_many_tokens/.test(kind) || /prompt is too long|maximum context length|too many tokens/i.test(message)) code = "context_length_exceeded";
  else if (/quota|billing|credit|balance/.test(kind) || /insufficient (quota|credit|balance)/i.test(message)) code = "insufficient_quota";
  else if (status === 429 || /rate_limit|slow_down/.test(kind)) code = "rate_limit_exceeded";
  else if (status === 503 || status === 529 || /overload/.test(kind)) code = "server_is_overloaded";
  else if (/stream_error/.test(kind)) code = "stream_error";
  else if (/invalid|authentication|permission|not_found/.test(kind)) code = "invalid_prompt";
  else code = status !== undefined && status < 500 ? "invalid_prompt" : "upstream_error";
  const mappedStatus = code === "rate_limit_exceeded" || code === "insufficient_quota" ? 429
    : code === "server_is_overloaded" ? 503
    : code === "invalid_prompt" || code === "context_length_exceeded" ? 400 : 502;
  const delay = retryAfter(headers) ?? retryAfter(error?.headers) ?? retryAfter(envelope?.headers);
  return new BridgeError(message, code, status ?? mappedStatus, delay !== undefined ? { "retry-after": delay } : undefined, {
    upstream: { ...(status !== undefined ? { status } : {}), body: payload },
  });
}

interface TransportFailure {
  name?: string;
  message: string;
  code?: string;
  cause?: TransportFailure;
  errors?: TransportFailure[];
}

function transportFailure(value: unknown, seen = new Set<unknown>()): TransportFailure {
  const error = record(value);
  const result: TransportFailure = { message: typeof error?.message === "string" ? error.message : typeof value === "string" ? value : "Upstream request failed" };
  if (seen.has(value)) return result;
  seen.add(value);
  if (typeof error?.name === "string") result.name = error.name;
  if (typeof error?.code === "string") result.code = error.code;
  if (error?.cause !== undefined) result.cause = transportFailure(error.cause, seen);
  if (Array.isArray(error?.errors)) result.errors = error.errors.map((cause: unknown) => transportFailure(cause, seen));
  return result;
}

function transportMessage(error: TransportFailure): string {
  const own = error.code ? `${error.message} (${error.code})` : error.message;
  return [own, ...(error.cause ? [transportMessage(error.cause)] : []), ...(error.errors?.map(transportMessage) ?? [])].filter(Boolean).join(": ");
}

/** Pick only diagnostics; fetch options and credential-command output must not escape. */
export function transportError(cause: unknown): BridgeError {
  if (cause instanceof BridgeError) return cause;
  const failure = transportFailure(cause);
  return new BridgeError(transportMessage(failure), "upstream_error", 502, undefined, { cause: failure });
}
