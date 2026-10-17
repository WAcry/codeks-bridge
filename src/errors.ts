/** A failure that keeps the Responses retry classification and HTTP metadata. */
export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  constructor(message: string, code = "invalid_prompt", status = 400, headers?: Record<string, string>) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}

export function upstreamError(status: number, payload: any, headers?: Headers): BridgeError {
  const error = payload?.error ?? payload;
  const message = typeof error?.message === "string" ? error.message : `Upstream returned HTTP ${status}`;
  const kind = String(error?.code ?? error?.type ?? "");
  let code: string;
  if (/context_length|too_many_tokens/.test(kind) || /prompt is too long|maximum context length/i.test(message)) code = "context_length_exceeded";
  else if (/quota|billing|credit|balance/.test(kind) || /insufficient (quota|credit|balance)/i.test(message)) code = "insufficient_quota";
  else if (status === 429) code = "rate_limit_exceeded";
  else if (status === 503 || status === 529 || /overloaded/.test(kind)) code = "server_is_overloaded";
  else if (status >= 500) code = "upstream_error";
  else code = "invalid_prompt";
  const retryAfter = headers?.get("retry-after");
  return new BridgeError(message, code, status, retryAfter ? { "retry-after": retryAfter } : undefined);
}
