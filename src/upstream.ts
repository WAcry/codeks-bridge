import { upstreamHeaders } from "./auth.ts";
import { BridgeError, upstreamError } from "./errors.ts";
import type { ResolvedModel } from "./types.ts";

/** base_url includes any API version prefix; path is appended, never resolved from /. */
export async function upstreamFetch(route: ResolvedModel, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const url = route.upstream.base_url.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  const headers = await upstreamHeaders(route.upstream, signal);
  const idle = new AbortController();
  const combined = AbortSignal.any([signal, idle.signal]);
  const timeoutMs = route.upstream.stream_idle_timeout_ms ?? 300_000;
  let timer: NodeJS.Timeout;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new BridgeError("Upstream stream timed out", "stream_error", 504)), timeoutMs).unref();
  };
  reset();
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: combined, redirect: "error" });
  } catch {
    clearTimeout(timer!);
    if (combined.aborted) throw combined.reason;
    throw new BridgeError("Could not reach the upstream", "upstream_error", 502);
  }
  // Downstream keepalives do not count as upstream progress. Time out both the
  // wait for headers and an idle response body, including a stalled error body.
  if (response.body) {
    const reader = response.body.getReader();
    response = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { clearTimeout(timer); controller.close(); }
          else { reset(); controller.enqueue(chunk.value); }
        } catch (error) {
          clearTimeout(timer);
          controller.error(combined.aborted ? combined.reason : error);
        }
      },
      async cancel(reason) {
        clearTimeout(timer);
        await reader.cancel(reason);
      },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  } else clearTimeout(timer!);
  if (!response.ok) {
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (combined.aborted) throw combined.reason;
    throw upstreamError(response.status, payload, response.headers);
  }
  return response;
}
