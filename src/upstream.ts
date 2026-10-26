import { upstreamHeaders } from "./auth.ts";
import { BridgeError, transportError, upstreamError, UpstreamHttpError } from "./errors.ts";
import { captureUpstream } from "./inspect/capture.ts";
import type { Api, UpstreamConfig } from "./types.ts";
import { upstreamBaseUrl } from "./config.ts";
import { refreshChatgptCredentials } from "./chatgpt-auth.ts";

/** base_url includes any API version prefix; path is appended, never resolved from /. */
export async function upstreamFetch(route: { upstream: UpstreamConfig; profile: { api: Api } }, path: string, body: unknown, signal: AbortSignal, requestHeaders?: Headers, protocolHeaders?: Record<string, string | string[]>, fetch: typeof globalThis.fetch = globalThis.fetch, recoverAuth = true): Promise<Response> {
  signal.throwIfAborted();
  const url = upstreamBaseUrl(route.upstream).replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  const headers = await upstreamHeaders(route.upstream, route.profile.api, signal, requestHeaders, fetch);
  signal.throwIfAborted();
  for (const [name, value] of Object.entries(protocolHeaders ?? {})) {
    // A protocol may require additional comma-separated feature flags without
    // replacing the endpoint's configured flags. Scalar headers still replace.
    headers.set(name, Array.isArray(value)
      ? [...new Set([...(headers.get(name)?.split(",") ?? []), ...value].map(v => v.trim()).filter(Boolean))].join(",")
      : value);
  }
  const payload = JSON.stringify(body);
  const call = captureUpstream(url, headers, payload);
  const idle = new AbortController();
  const combined = AbortSignal.any([signal, idle.signal]);
  const timeoutMs = route.upstream.stream_idle_timeout_ms === undefined ? 300_000 : route.upstream.stream_idle_timeout_ms;
  let timer: NodeJS.Timeout | undefined;
  const reset = (duration = timeoutMs) => {
    clearTimeout(timer);
    timer = undefined;
    if (duration === null) return;
    timer = setTimeout(() => idle.abort(new BridgeError("Upstream stream timed out", "stream_error", 504)), duration).unref();
  };
  const headersTimeout = route.upstream.headers_timeout_ms === undefined ? timeoutMs : route.upstream.headers_timeout_ms;
  if (headersTimeout !== null) reset(headersTimeout);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: payload, signal: combined, redirect: "error" });
  } catch (error) {
    clearTimeout(timer);
    call?.failed(combined.aborted ? combined.reason : error);
    if (combined.aborted) throw combined.reason;
    throw transportError(error);
  }
  // Downstream keepalives do not count as upstream progress. The body timer
  // starts after headers, including when the header wait has no deadline.
  reset();
  call?.received(response);
  if (response.body) {
    const reader = response.body.getReader();
    response = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { clearTimeout(timer); call?.done("complete"); controller.close(); }
          else { reset(); call?.chunk(chunk.value); controller.enqueue(chunk.value); }
        } catch (error) {
          clearTimeout(timer);
          const cause = combined.aborted ? combined.reason : transportError(error);
          call?.done("error", cause);
          controller.error(cause);
        }
      },
      async cancel(reason) {
        clearTimeout(timer);
        call?.done("unread");
        await reader.cancel(reason);
      },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  } else { clearTimeout(timer); call?.done("complete"); }
  if (!response.ok) {
    const text = await response.text();
    if (combined.aborted) throw combined.reason;
    if (response.status === 401 && recoverAuth && route.upstream.auth?.type === "chatgpt") {
      // Authentication recovery only: no stream has been accepted, and model
      // failures keep the client's existing retry policy.
      await refreshChatgptCredentials(route.upstream.auth, {
        accessToken: headers.get("authorization")!.slice("Bearer ".length),
        accountId: headers.get("chatgpt-account-id")!,
      }, fetch);
      return upstreamFetch(route, path, body, signal, requestHeaders, protocolHeaders, fetch, false);
    }
    if (route.profile.api === "responses") throw new UpstreamHttpError(response.status, text, response.headers);
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* Non-JSON error bodies are still useful diagnostics. */ }
    throw upstreamError(response.status, payload, response.headers);
  }
  return response;
}
