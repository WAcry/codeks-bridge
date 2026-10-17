/** A failure that keeps the Responses retry classification and HTTP metadata. */
export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly upstreamCode?: string;
  constructor(message: string, code = "invalid_prompt", status = 400, headers?: Record<string, string>, upstreamCode?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
    this.headers = headers;
    this.upstreamCode = upstreamCode;
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
  return new BridgeError(message, code, status, retryAfter ? { "retry-after": retryAfter } : undefined, kind);
}

/** A narrow input-rejection signal, not evidence of a permanent encryption boundary. */
export function isEncryptedContentRejection(error: unknown): error is BridgeError {
  if (!(error instanceof BridgeError)) return false;
  // HTTP failures are normalized above; SSE validation failures retain their code.
  const streamValidation = error.status === 502 && ["invalid_encrypted_content", "validation_error", "invalid_request_error", "400"].includes(error.code);
  if (error.status !== 400 && !streamValidation) return false;
  const code = error.upstreamCode ?? error.code;
  return code === "invalid_encrypted_content" ||
    /"code"\s*:\s*"invalid_encrypted_content"/.test(error.message) ||
    /\binvalid encrypted (?:summary|compaction)\b/i.test(error.message) ||
    /\bencrypted (?:content|summary|compaction)\b[^\n]{0,200}\b(?:could not|cannot) be (?:verified|decrypted|parsed)\b/i.test(error.message);
}
