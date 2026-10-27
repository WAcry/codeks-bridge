import type { IncomingHttpHeaders } from "node:http";

export type HeaderRecord = Record<string, string | string[]>;

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

/** Each HTTP leg owns its framing; metadata is forwarded unless it conflicts. */
function withoutTransportHeaders(input?: Headers): Headers {
  const headers = new Headers(input);
  const connection = (headers.get("connection") ?? "").split(",").map(name => name.trim()).filter(Boolean);
  for (const name of [...connection, ...HOP_BY_HOP, "content-length", "content-encoding", "content-md5", "digest", "content-digest", "repr-digest"]) headers.delete(name);
  return headers;
}

export function incomingHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  }
  return headers;
}

/** Credentials belong to the selected upstream, never to the bridge client. */
export function forwardRequestHeaders(input?: Headers, authHeader?: string): Headers {
  const headers = withoutTransportHeaders(input);
  for (const name of ["host", "accept-encoding", "authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie", ...(authHeader ? [authHeader] : [])]) headers.delete(name);
  return headers;
}

export function forwardResponseHeaders(input: Headers, rewritten = true): HeaderRecord {
  const headers = withoutTransportHeaders(input);
  // The catalog belongs to the bridge even when the selected upstream also
  // serves Codex. Rewritten bodies need their own content type.
  headers.delete("x-models-etag");
  if (rewritten) {
    headers.delete("content-type");
    headers.delete("etag");
  }
  const result: HeaderRecord = Object.fromEntries(headers);
  const cookies = headers.getSetCookie();
  if (cookies.length) result["set-cookie"] = cookies;
  return result;
}
