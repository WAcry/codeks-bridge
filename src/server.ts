import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { validateConfig, resolveModel, resolveCompactionModel } from "./config.ts";
import { buildCatalog, MAX_HTTP_CATALOG_BYTES } from "./catalog.ts";
import { reasoningSummaryRequested } from "./profiles.ts";
import { BridgeError, ResponsesIncompleteError, ResponsesStreamError, transportError, UpstreamHttpError } from "./errors.ts";
import { ResponseWriter, usageJson } from "./writer.ts";
import { runResponses } from "./backends/responses.ts";
import { runAnthropic } from "./backends/anthropic.ts";
import { runDeepSeek } from "./backends/deepseek.ts";
import { compact, isCompactionRequest } from "./compaction.ts";
import { CompactionHandoffStore } from "./compaction-handoff.ts";
import { Inspector, type Exchange } from "./inspect/capture.ts";
import { isInspectorPath, serveInspector } from "./inspect/http.ts";
import { forwardResponseHeaders, incomingHeaders, type HeaderRecord } from "./headers.ts";
import type { AdapterId, Backend, BridgeConfig, BridgeServerOptions, ResponsesRequest } from "./types.ts";

const BACKENDS: Record<AdapterId, Backend> = { "gpt-responses": runResponses, "claude-messages": runAnthropic, "deepseek-chat": runDeepSeek };
function json(res: ServerResponse, status: number, body: unknown, headers: HeaderRecord = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (!res.hasHeader("cache-control")) res.setHeader("cache-control", "no-store");
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function upstreamHttpFailure(res: ServerResponse, error: UpstreamHttpError): void {
  res.writeHead(error.status, forwardResponseHeaders(error.headers, false));
  res.end(error.body);
}
async function readRequest(req: IncomingMessage, maxMiB: number, exchange?: Exchange): Promise<ResponsesRequest> {
  const maxBytes = maxMiB * 1024 * 1024;
  let size = 0;
  const chunks: Buffer[] = [];
  // Keep the socket alive long enough to deliver HTTP 413, then close it.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError(`Request exceeds ${maxMiB} MiB`, "invalid_prompt", 413, { connection: "close" });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  exchange?.received(text);
  let request: any;
  try { request = JSON.parse(text); }
  catch { throw new BridgeError("Request body must be JSON"); }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new BridgeError("Request must be an object");
  exchange?.parsed(request);
  if (typeof request.model !== "string") throw new BridgeError("model is required");
  if (request.input !== undefined && typeof request.input !== "string" && !Array.isArray(request.input)) throw new BridgeError("input must be a string or an array");
  if (Array.isArray(request.input) && request.input.some((x: unknown) => !x || typeof x !== "object" || Array.isArray(x))) throw new BridgeError("input items must be objects");
  if (request.tools !== undefined && !Array.isArray(request.tools)) throw new BridgeError("tools must be an array");
  if (request.stream !== undefined && typeof request.stream !== "boolean") throw new BridgeError("stream must be a boolean");
  if (request.previous_response_id || request.conversation || request.background) throw new BridgeError("Send the complete input history; server-side conversations and background requests are unsupported");
  return request;
}
function authenticated(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Creates a server without opening a socket, so callers control its lifecycle. */
export function createBridgeServer(value: BridgeConfig, options: BridgeServerOptions = {}): Server {
  const config = validateConfig(value);
  const compactions = new CompactionHandoffStore(config, BACKENDS);
  const catalog = JSON.stringify(buildCatalog(config));
  const catalogBytes = Buffer.byteLength(catalog);
  const catalogEtag = `"${createHash("sha256").update(catalog).digest("hex")}"`;
  const token = config.token_env ? process.env[config.token_env] : undefined;
  if (config.token_env && !token) throw new BridgeError(`Missing bridge token environment variable: ${config.token_env}`);
  const host = config.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !token) throw new BridgeError("Set token_env when listening outside loopback");
  const inspector = new Inspector(config);
  return createServer((req, res) => void inspector.scope(async () => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new Error("Client disconnected")); };
    res.on("close", abort);
    let writer: ResponseWriter | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    let startStream: (() => void) | undefined;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (isInspectorPath(url.pathname)) {
        await serveInspector(req, res, url, inspector, { configured: !!token, valid: () => authenticated(req, token) });
        return;
      }
      if (!authenticated(req, token)) { json(res, 401, { error: { code: "invalid_api_key", message: "Invalid bridge token" } }); return; }
      if (req.headers.origin !== undefined && !token) {
        throw new BridgeError("Browser requests require a configured bridge token", "invalid_prompt", 403);
      }
      const path = url.pathname.replace(/^\/v1(?=\/)/, "");
      if (req.method === "GET" && path === "/health") { json(res, 200, { status: "ok" }); return; }
      if (req.method === "GET" && path === "/models") {
        if (catalogBytes > MAX_HTTP_CATALOG_BYTES) {
          throw new BridgeError("HTTP model catalog exceeds the client's 1 MiB limit. Reduce model aliases or export a static catalog and use model_catalog_json.", "invalid_prompt", 413);
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", etag: catalogEtag });
        res.end(catalog); return;
      }
      if (req.method !== "POST" || path !== "/responses") {
        json(res, 404, { error: { code: "invalid_prompt", message: "Use POST /v1/responses with remote_compaction = v2" } }); return;
      }
      res.setHeader("x-models-etag", catalogEtag);
      const exchange = inspector.begin(req, res);
      const original = await readRequest(req, config.request_max_mib ?? 512, exchange);
      const requestHeaders = incomingHeaders(req.headers);
      const request = await options.transformRequest?.(original, { headers: requestHeaders }) ?? original;
      const caller = resolveModel(config, request.model);
      const compacting = isCompactionRequest(request);
      // Restore history for the actual consumer before materializing any handoffs.
      const route = compacting ? resolveCompactionModel(config, caller) : caller;
      // A distinct alias selects its own effort preset, even for the same deployment.
      const executionRequest = route.slug === caller.slug ? request : {
        ...request, model: route.slug,
        reasoning: { ...request.reasoning, effort: route.profile.default_effort },
      };
      const responsesLite = req.headers["x-openai-internal-codex-responses-lite"] === "true" ||
        (Array.isArray(request.input) && request.input.some((item) => item.type === "additional_tools"));
      exchange?.routed(route, responsesLite);
      const backend = BACKENDS[route.profile.id];
      const streaming = request.stream === true;
      writer = new ResponseWriter(streaming ? res : { write() {} }, {
        model: request.model, showSummary: reasoningSummaryRequested(request),
        onEvent: options.onResponseEvent ? event => options.onResponseEvent!(request, event) : undefined,
      });
      if (streaming) startStream = () => {
        if (res.headersSent || controller.signal.aborted) return;
        if (!res.hasHeader("cache-control")) res.setHeader("cache-control", "no-cache");
        if (!res.hasHeader("x-accel-buffering")) res.setHeader("x-accel-buffering", "no");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        writer!.start();
        keepalive = setInterval(() => writer?.keepalive(), 15_000).unref();
      };
      else writer.start();
      const context = { request: executionRequest, route, signal: controller.signal, requestHeaders, fetch: options.fetch, responsesLite, onAccepted: (headers?: Headers) => {
        for (const [name, value] of Object.entries(headers ? forwardResponseHeaders(headers) : {})) res.setHeader(name, value);
        startStream?.();
      } };
      context.request = await compactions.materialize(context);
      let result;
      if (compacting) {
        const compacted = await compact(context, backend);
        writer.addItem(compacted.item);
        result = { usage: compacted.usage, endTurn: true };
      } else {
        result = await backend(context, writer);
      }
      writer.complete(result.usage, result.endTurn);
      if (streaming) res.end();
      else json(res, 200, writer.nativeResponse ?? {
        id: writer.responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: request.model,
        status: "completed", output: writer.outputItems, usage: usageJson(result.usage),
        ...(result.endTurn !== undefined ? { end_turn: result.endTurn } : {}),
      });
    } catch (cause) {
      if (controller.signal.aborted || res.destroyed) return;
      if (cause instanceof UpstreamHttpError) { upstreamHttpFailure(res, cause); return; }
      if (cause instanceof ResponsesIncompleteError) {
        startStream?.();
        writer!.nativeIncomplete(cause.response, cause.event);
        if (res.headersSent) res.end();
        else json(res, 200, writer!.nativeResponse);
        return;
      }
      if (cause instanceof ResponsesStreamError) {
        // Auxiliary compaction can fail before the target request starts.
        // Preserve the upstream error code even while HTTP headers are withheld.
        if (!res.headersSent && cause.headers) {
          for (const [name, value] of Object.entries(forwardResponseHeaders(cause.headers))) res.setHeader(name, value);
        }
        startStream?.();
        if (res.headersSent && writer) {
          if (cause.response) writer.nativeFailed(cause.response, cause.event);
          else writer.fail(cause.error);
          res.end();
        } else json(res, 502, cause.response ?? { error: cause.error });
        return;
      }
      const error = cause instanceof BridgeError ? cause : transportError(cause);
      const payload = { code: error.code, message: error.message, ...(error.headers ? { headers: error.headers } : {}), ...(error.upstream ? { upstream: error.upstream } : {}) };
      if (res.headersSent && writer) { writer.fail(payload); res.end(); }
      else json(res, error.status, { error: payload }, error.headers);
    } finally {
      if (keepalive) clearInterval(keepalive);
      res.off("close", abort);
    }
  }));
}
