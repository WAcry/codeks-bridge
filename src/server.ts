import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { validateConfig, resolveModel } from "./config.ts";
import { buildCatalog, MAX_HTTP_CATALOG_BYTES } from "./catalog.ts";
import { reasoningSummaryRequested } from "./profiles.ts";
import { BridgeError, ResponsesIncompleteError, ResponsesStreamError, transportError, UpstreamHttpError } from "./errors.ts";
import { ResponseWriter, usageJson } from "./writer.ts";
import { runResponses } from "./backends/responses.ts";
import { runAnthropic } from "./backends/anthropic.ts";
import { runDeepSeek } from "./backends/deepseek.ts";
import { compact, isCompactionRequest } from "./compaction.ts";
import { LazyCompactionStore } from "./lazy-compaction.ts";
import type { AdapterId, Backend, BridgeConfig, ResponsesRequest } from "./types.ts";

const BACKENDS: Record<AdapterId, Backend> = { "gpt-responses": runResponses, "claude-messages": runAnthropic, "deepseek-chat": runDeepSeek };
const MAX_BODY_BYTES = 64 * 1024 * 1024;
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
function upstreamHttpFailure(res: ServerResponse, error: UpstreamHttpError): void {
  const headers = new Headers(error.headers);
  const connectionHeaders = (headers.get("connection") ?? "").split(",").map(name => name.trim()).filter(Boolean);
  // fetch decodes the body; hop-by-hop and encoded-length headers no longer apply.
  for (const name of [...connectionHeaders, "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length"]) headers.delete(name);
  res.writeHead(error.status, Object.fromEntries(headers));
  res.end(error.body);
}
async function readRequest(req: IncomingMessage): Promise<ResponsesRequest> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError("Request exceeds 64 MiB", "invalid_prompt", 413);
    chunks.push(chunk);
  }
  let request: any;
  try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new BridgeError("Request body must be JSON"); }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new BridgeError("Request must be an object");
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
export function createBridgeServer(value: BridgeConfig): Server {
  const config = validateConfig(value);
  const compactions = new LazyCompactionStore(config, BACKENDS);
  const catalog = JSON.stringify(buildCatalog(config));
  const catalogBytes = Buffer.byteLength(catalog);
  const catalogEtag = `"${createHash("sha256").update(catalog).digest("hex")}"`;
  const token = config.token_env ? process.env[config.token_env] : undefined;
  if (config.token_env && !token) throw new BridgeError(`Missing bridge token environment variable: ${config.token_env}`);
  const host = config.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !token) throw new BridgeError("Set token_env when listening outside loopback");
  return createServer(async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new Error("Client disconnected")); };
    res.on("close", abort);
    let writer: ResponseWriter | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    let startStream: (() => void) | undefined;
    try {
      if (!authenticated(req, token)) { json(res, 401, { error: { code: "invalid_api_key", message: "Invalid bridge token" } }); return; }
      if (req.headers.origin !== undefined && !token) {
        throw new BridgeError("Browser requests require a configured bridge token", "invalid_prompt", 403);
      }
      const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/v1(?=\/)/, "");
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
      const request = await readRequest(req);
      const route = resolveModel(config, request.model);
      const responsesLite = req.headers["x-openai-internal-codex-responses-lite"] === "true" ||
        (Array.isArray(request.input) && request.input.some((item) => item.type === "additional_tools"));
      const backend = BACKENDS[route.profile.id];
      const streaming = request.stream === true;
      writer = new ResponseWriter(streaming ? res : { write() {} }, { model: request.model, showSummary: reasoningSummaryRequested(request) });
      if (streaming) startStream = () => {
        if (res.headersSent || controller.signal.aborted) return;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
        res.flushHeaders();
        writer!.start();
        keepalive = setInterval(() => writer?.keepalive(), 15_000).unref();
      };
      else writer.start();
      const context = { request, route, signal: controller.signal, responsesLite, onAccepted: (headers?: Headers) => {
        for (const name of ["x-request-id", "request-id"]) {
          const value = headers?.get(name);
          if (value) res.setHeader(name, value);
        }
        startStream?.();
      } };
      context.request = await compactions.materialize(context);
      let result;
      if (isCompactionRequest(request)) {
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
  });
}
