import { upstreamHeaders } from "./auth.ts";
import { BridgeError, transportError, upstreamError, UpstreamHttpError } from "./errors.ts";
import { captureUpstream } from "./inspect/capture.ts";
import type { ResolvedModel } from "./types.ts";

/** base_url includes any API version prefix; path is appended, never resolved from /. */
export async function upstreamFetch(route: ResolvedModel, path: string, body: unknown, signal: AbortSignal, requestHeaders?: Record<string, string>): Promise<Response> {
  const url = route.upstream.base_url.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  const headers = await upstreamHeaders(route.upstream, route.profile.api, signal);
  for (const [name, value] of Object.entries(requestHeaders ?? {})) headers.set(name, value);
  const payload = JSON.stringify(body);
  const call = captureUpstream(url, headers, payload);
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
    response = await fetch(url, { method: "POST", headers, body: payload, signal: combined, redirect: "error" });
  } catch (error) {
    clearTimeout(timer!);
    call?.failed(combined.aborted ? combined.reason : error);
    if (combined.aborted) throw combined.reason;
    throw transportError(error);
  }
  // Downstream keepalives do not count as upstream progress. Time out both the
  // wait for headers and an idle response body, including a stalled error body.
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
  } else { clearTimeout(timer!); call?.done("complete"); }
  if (!response.ok) {
    const text = await response.text();
    if (combined.aborted) throw combined.reason;
    if (route.profile.api === "responses") throw new UpstreamHttpError(response.status, text, response.headers);
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* Non-JSON error bodies are still useful diagnostics. */ }
    throw upstreamError(response.status, payload, response.headers);
  }
  return response;
}
