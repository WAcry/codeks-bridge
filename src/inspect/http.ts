// HTTP routes for the inspector: static UI files and a small JSON API.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import type { Inspector } from "./capture.ts";
import { detail, listView, stateView, writeExport } from "./view.ts";

// src/inspect and dist/inspect are both two levels below the package root.
const UI_DIR = new URL("../../ui/", import.meta.url);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};
const PAGE_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_API_BODY = 64 * 1024;

export function isInspectorPath(path: string): boolean {
  return path === "/inspect" || path.startsWith("/inspect/");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function failure(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

/** Without a token, only same-origin pages served from a loopback name may use the API. */
function localPage(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname; } catch { return false; }
  if (!LOOPBACK.has(hostname)) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_API_BODY) return undefined;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

async function serveFile(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  const type = TYPES[extname(name)];
  if (!type || !/^[A-Za-z0-9][\w.-]*$/.test(name)) { failure(res, 404, "not_found", "Not found"); return; }
  let body: Buffer;
  try { body = await readFile(new URL(name, UI_DIR)); }
  catch { failure(res, 404, "not_found", "Not found"); return; }
  res.writeHead(200, { ...PAGE_HEADERS, "content-type": type, "content-length": String(body.length) });
  res.end(req.method === "HEAD" ? undefined : body);
}

export async function serveInspector(
  req: IncomingMessage, res: ServerResponse, url: URL, inspector: Inspector,
  token: { configured: boolean; valid: () => boolean },
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (!path.startsWith("/inspect/api/")) {
    if (method !== "GET" && method !== "HEAD") { failure(res, 405, "method_not_allowed", "Use GET"); return; }
    if (path === "/inspect") { res.writeHead(308, { location: "/inspect/" + url.search }); res.end(); return; }
    await serveFile(req, res, path === "/inspect/" ? "index.html" : path.slice("/inspect/".length));
    return;
  }
  if (token.configured ? !token.valid() : !localPage(req)) {
    if (token.configured) failure(res, 401, "invalid_api_key", "Enter the bridge token");
    else failure(res, 403, "forbidden", "Open the inspector from a loopback address, or configure token_env");
    return;
  }
  const route = path.slice("/inspect/api/".length);
  if (route === "state" && method === "GET") { send(res, 200, stateView(inspector)); return; }
  if (route === "capture" && method === "POST") {
    const body = await readJson(req);
    if (typeof body?.enabled !== "boolean") { failure(res, 400, "invalid_request", "Send {\"enabled\": true|false}"); return; }
    inspector.capturing = body.enabled;
    inspector.rev++;
    send(res, 200, stateView(inspector));
    return;
  }
  if (route === "exchanges" && method === "DELETE") { inspector.clear(); send(res, 200, stateView(inspector)); return; }
  if (route === "exchanges" && method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0);
    send(res, 200, listView(inspector, Number.isFinite(since) ? since : 0));
    return;
  }
  if (route.startsWith("exchanges/") && method === "GET") {
    const exchange = inspector.exchanges.get(route.slice("exchanges/".length));
    if (!exchange) { failure(res, 404, "not_found", "Exchange not found; it may have been cleared or evicted"); return; }
    send(res, 200, detail(exchange));
    return;
  }
  if (route === "export" && method === "GET") { await writeExport(inspector, res); return; }
  failure(res, 404, "not_found", "Unknown inspector API route");
}
