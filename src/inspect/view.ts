// JSON views of captured exchanges. Bodies stay complete; the UI decides how
// much to show. Annotations use the same replay rules as prepareHistory.
import type { ServerResponse } from "node:http";
import { decodeCompaction, decodeReasoning, type CompactionCarrier, type StatePayload } from "../carrier.ts";
import { resolveModel } from "../config.ts";
import { replaysReasoning, restoresNativeCompaction } from "../history.ts";
import type { ResolvedModel, StateOrigin } from "../types.ts";
import type { Exchange, Inspector, Message, Part } from "./capture.ts";

export interface SseRecord { t: number; event: string | null; data: string }

type Outcome = "active" | "completed" | "incomplete" | "failed" | "error" | "aborted";
interface Result { outcome: Outcome; error: string | null; usage: unknown }

export interface Annotation {
  target: "client.request" | "client.response";
  pointer: string;
  event?: number;
  kind: "reasoning" | "compaction";
  decision: "replay" | "drop" | "native" | "summary" | "reject" | "output";
  reason: string;
  source: { aliases: string[]; model: string; adapter: string; origin_id: string } | null;
  format: string | null;
  decoded: unknown;
}

/** Splits timed text into SSE events. An event takes the time of the part that completed it. */
export function sseEvents(parts: readonly Part[]): SseRecord[] {
  const events: SseRecord[] = [];
  let event: string | null = null;
  let data: string[] = [];
  let hasData = false;
  const line = (text: string, t: number) => {
    if (text === "") {
      if (hasData) events.push({ t, event, data: data.join("\n") });
      event = null;
      data = [];
      hasData = false;
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") { data.push(value); hasData = true; }
    else if (field === "event") event = value;
  };
  let buffer = "";
  let t = 0;
  for (const part of parts) {
    t = part.t;
    buffer += part.text;
    let start = 0;
    // A trailing CR waits for the next part, which may start with LF.
    for (const match of buffer.matchAll(/\r\n|\n|\r(?=[^\n])/g)) {
      line(buffer.slice(start, match.index), t);
      start = match.index + match[0].length;
    }
    buffer = buffer.slice(start);
  }
  if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
  if (buffer) line(buffer, t);
  line("", t);
  return events;
}

function isSse(message: Message): boolean {
  return (message.headers?.["content-type"] ?? "").toLowerCase().includes("text/event-stream");
}

function parse(text: string | undefined): any {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function terminal(data: any, status?: number): Result | undefined {
  const response = data?.response;
  switch (data?.type) {
    case "response.completed": return { outcome: "completed", error: null, usage: response?.usage ?? null };
    case "response.incomplete": return { outcome: "incomplete", error: response?.incomplete_details?.reason ?? null, usage: response?.usage ?? null };
    case "response.failed": return { outcome: "failed", error: response?.error?.message ?? null, usage: response?.usage ?? null };
    case "error": return { outcome: "error", error: data.error?.message ?? data.message ?? null, usage: null };
  }
  if (status !== undefined && data?.object === "response") {
    if (data.status === "completed") return { outcome: "completed", error: null, usage: data.usage ?? null };
    if (data.status === "incomplete") return { outcome: "incomplete", error: data.incomplete_details?.reason ?? null, usage: data.usage ?? null };
    if (data.status === "failed") return { outcome: "failed", error: data.error?.message ?? null, usage: data.usage ?? null };
  }
  return undefined;
}

const results = new WeakMap<Exchange, Result>();

/** What the client saw, from its terminal event or JSON body. */
function result(exchange: Exchange): Result {
  if (!exchange.closed) return { outcome: "active", error: null, usage: null };
  const cached = results.get(exchange);
  if (cached) return cached;
  const response = exchange.response;
  let value: Result;
  if (response.end === "cancelled") value = { outcome: "aborted", error: response.error ?? null, usage: null };
  else if (response.status === undefined) value = { outcome: "error", error: "No response was written", usage: null };
  else if (isSse(response)) {
    const events = sseEvents(response.parts);
    value = { outcome: "error", error: "Stream ended without a terminal event", usage: null };
    for (let i = events.length - 1; i >= 0; i--) {
      const found = terminal(parse(events[i].data));
      if (found) { value = found; break; }
    }
  } else {
    const body = parse(response.text());
    const message = body?.error?.message ?? (typeof body?.error === "string" ? body.error : null);
    value = response.status >= 400
      ? { outcome: "error", error: message ?? response.text().slice(0, 200), usage: null }
      : terminal(body, response.status) ?? { outcome: "completed", error: null, usage: body?.usage ?? null };
  }
  results.set(exchange, value);
  return value;
}

const originNames = new WeakMap<Inspector, Map<string, string[]>>();

/** Maps source fingerprints back to the aliases that produce them. */
function aliases(inspector: Inspector): Map<string, string[]> {
  let names = originNames.get(inspector);
  if (names) return names;
  names = new Map();
  for (const alias of Object.keys(inspector.config.models)) {
    const id = resolveModel(inspector.config, alias).origin.id;
    names.set(id, [...names.get(id) ?? [], alias]);
  }
  originNames.set(inspector, names);
  return names;
}

function source(inspector: Inspector, origin: StateOrigin): Annotation["source"] {
  return { aliases: aliases(inspector).get(origin.id) ?? [], model: origin.model, adapter: origin.adapter, origin_id: origin.id };
}

function header(exchange: Exchange, name: string): string | null {
  return exchange.headers[name] ?? null;
}

export function summary(exchange: Exchange) {
  const { outcome, error, usage } = result(exchange);
  const route = exchange.route;
  return {
    id: exchange.id,
    seq: exchange.seq,
    rev: exchange.rev,
    started_at: exchange.startedAt,
    duration_ms: exchange.durationMs ?? null,
    active: !exchange.closed,
    model: exchange.meta.model,
    adapter: route?.profile.id ?? null,
    api: route?.profile.api ?? null,
    upstream: route?.config.upstream ?? null,
    upstream_model: route?.config.model ?? null,
    kind: exchange.meta.kind,
    stream: exchange.meta.stream,
    status: exchange.response.status ?? null,
    outcome,
    error,
    usage,
    thread: {
      session_id: header(exchange, "session-id") ?? header(exchange, "session_id"),
      thread_id: header(exchange, "thread-id") ?? header(exchange, "thread_id"),
      parent_thread_id: header(exchange, "x-codex-parent-thread-id"),
      subagent: header(exchange, "x-openai-subagent"),
      window_id: header(exchange, "x-codex-window-id"),
    },
    input_items: exchange.meta.input_items,
    preview: exchange.meta.preview,
    upstream_calls: exchange.calls.map(call => ({
      label: call.label,
      status: call.response?.status ?? null,
      end: call.response?.end ?? (call.error !== undefined ? "error" : "active"),
    })),
    bytes: {
      request: exchange.requestBytes,
      response: exchange.response.bytes,
      upstream_request: exchange.calls.reduce((sum, call) => sum + call.bytes, 0),
      upstream_response: exchange.calls.reduce((sum, call) => sum + (call.response?.bytes ?? 0), 0),
    },
  };
}

function routeView(inspector: Inspector, route: ResolvedModel, responsesLite: boolean | undefined) {
  const names = (ids: ReadonlySet<string>) => [...new Set([...ids].flatMap(id => aliases(inspector).get(id) ?? []))];
  return {
    alias: route.slug,
    catalog: route.config.catalog,
    adapter: route.profile.id,
    api: route.profile.api,
    upstream: route.config.upstream,
    base_url: route.upstream.base_url,
    upstream_model: route.config.model,
    origin_id: route.origin.id,
    reasoning_format: route.profile.reasoning_format,
    native_compaction_format: route.profile.native_compaction_format ?? null,
    compaction_mode: route.compaction.mode,
    native_replay: route.compaction.native_replay,
    replay: { reasoning_from: names(route.replay.reasoning), native_compaction_from: names(route.replay.native_compaction) },
    responses_lite: responsesLite ?? false,
  };
}

function messageView(message: Message | undefined) {
  if (!message) return null;
  return {
    status: message.status ?? null,
    status_text: message.statusText ?? null,
    headers: message.headers ?? {},
    headers_ms: message.headersMs ?? null,
    ended_ms: message.endedMs ?? null,
    end: message.end,
    error: message.error ?? null,
    body: { text: message.text(), bytes: message.bytes },
    events: isSse(message) ? sseEvents(message.parts) : null,
  };
}

function reasoningInput(inspector: Inspector, route: ResolvedModel, item: any, pointer: string): Annotation {
  const base = { target: "client.request" as const, pointer, kind: "reasoning" as const };
  let carrier: StatePayload | undefined;
  try { carrier = decodeReasoning(item.encrypted_content); }
  catch { return { ...base, decision: "reject", reason: "malformed", source: null, format: null, decoded: null }; }
  if (!carrier) return { ...base, decision: "drop", reason: "not_bridge_state", source: null, format: null, decoded: null };
  const replay = replaysReasoning(carrier, route);
  const reason = replay
    ? carrier.source.id === route.origin.id ? "same_source" : "allowed_source"
    : route.replay.reasoning.has(carrier.source.id) ? "format_mismatch" : "source_not_allowed";
  return { ...base, decision: replay ? "replay" : "drop", reason, source: source(inspector, carrier.source), format: carrier.format, decoded: carrier };
}

function compactionInput(inspector: Inspector, route: ResolvedModel, item: any, pointer: string): Annotation {
  const base = { target: "client.request" as const, pointer, kind: "compaction" as const };
  const carrier: CompactionCarrier | undefined = decodeCompaction(item.encrypted_content);
  if (!carrier) return { ...base, decision: "reject", reason: "not_bridge_state", source: null, format: null, decoded: null };
  const native = carrier.native;
  const restored = restoresNativeCompaction(carrier, route);
  const reason = restored ? "native_restored"
    : !native ? "no_native"
      : !route.compaction.native_replay ? "native_replay_disabled"
        : !route.replay.native_compaction.has(native.source.id) ? "source_not_allowed" : "format_mismatch";
  return {
    ...base, decision: restored ? "native" : "summary", reason,
    source: native ? source(inspector, native.source) : null, format: native?.format ?? null, decoded: carrier,
  };
}

function outputNote(inspector: Inspector, item: any, target: Pick<Annotation, "target" | "pointer" | "event">): Annotation | undefined {
  if (item?.type === "reasoning") {
    let carrier: StatePayload | undefined;
    try { carrier = decodeReasoning(item.encrypted_content); } catch { return undefined; }
    if (!carrier) return undefined;
    return { ...target, kind: "reasoning", decision: "output", reason: "output", source: source(inspector, carrier.source), format: carrier.format, decoded: carrier };
  }
  if (item?.type === "compaction" || item?.type === "compaction_summary") {
    const carrier = decodeCompaction(item.encrypted_content);
    if (!carrier) return undefined;
    return {
      ...target, kind: "compaction", decision: "output", reason: "output",
      source: carrier.native ? source(inspector, carrier.native.source) : null, format: carrier.native?.format ?? null, decoded: carrier,
    };
  }
  return undefined;
}

function annotations(exchange: Exchange, client: ReturnType<typeof messageView>): Annotation[] {
  const notes: Annotation[] = [];
  const { inspector, route } = exchange;
  const request = route ? parse(exchange.requestText) : undefined;
  if (route && Array.isArray(request?.input)) {
    request.input.forEach((item: any, index: number) => {
      const pointer = `/input/${index}`;
      if (item?.type === "reasoning") notes.push(reasoningInput(inspector, route, item, pointer));
      else if (item?.type === "compaction" || item?.type === "compaction_summary") notes.push(compactionInput(inspector, route, item, pointer));
    });
  }
  if (client?.events) {
    client.events.forEach((event, index) => {
      if (!event.data.includes("cxbr2:") && !event.data.includes("cxbc2:")) return;
      const data = parse(event.data);
      if (data?.type !== "response.output_item.done") return;
      const note = outputNote(inspector, data.item, { target: "client.response", event: index, pointer: "/item" });
      if (note) notes.push(note);
    });
  } else if (client && (client.body.text.includes("cxbr2:") || client.body.text.includes("cxbc2:"))) {
    const output = parse(client.body.text)?.output;
    if (Array.isArray(output)) output.forEach((item: any, index: number) => {
      const note = outputNote(inspector, item, { target: "client.response", pointer: `/output/${index}` });
      if (note) notes.push(note);
    });
  }
  return notes;
}

export function detail(exchange: Exchange) {
  const client = messageView(exchange.response);
  return {
    ...summary(exchange),
    route: exchange.route ? routeView(exchange.inspector, exchange.route, exchange.responsesLite) : null,
    client: {
      request: {
        method: exchange.method,
        path: exchange.path,
        headers: exchange.headers,
        body: { text: exchange.requestText ?? "", bytes: exchange.requestBytes },
      },
      response: client,
    },
    upstream: exchange.calls.map(call => ({
      index: call.index,
      label: call.label,
      started_ms: call.startedMs,
      method: call.method,
      url: call.url,
      headers: call.headers,
      body: { text: call.text, bytes: call.bytes },
      error: call.error ?? null,
      response: messageView(call.response),
    })),
    annotations: annotations(exchange, client),
  };
}

export function stateView(inspector: Inspector) {
  let active = 0;
  for (const exchange of inspector.exchanges.values()) if (!exchange.closed) active++;
  return {
    capturing: inspector.capturing,
    exchanges: inspector.exchanges.size,
    active,
    bytes: inspector.bytes,
    max_bytes: inspector.maxBytes,
    evicted: inspector.evicted,
    rev: inspector.rev,
    started_at: inspector.startedAt,
    models: Object.entries(inspector.config.models).map(([alias, model]) => {
      const route = resolveModel(inspector.config, alias);
      return { alias, catalog: model.catalog, adapter: route.profile.id, api: route.profile.api, upstream: model.upstream, upstream_model: model.model };
    }),
  };
}

export function listView(inspector: Inspector, since: number) {
  const exchanges = [...inspector.exchanges.values()];
  return { rev: inspector.rev, ids: exchanges.map(exchange => exchange.id), exchanges: exchanges.filter(exchange => exchange.rev > since).map(summary) };
}

function drained(res: ServerResponse): Promise<void> {
  return new Promise(resolve => {
    const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
    res.once("drain", done);
    res.once("close", done);
  });
}

/** Streams every stored exchange without building one large string. */
export async function writeExport(inspector: Inspector, res: ServerResponse): Promise<void> {
  const exportedAt = Date.now();
  const stamp = new Date(exportedAt).toISOString().replace(/[:.]/g, "-");
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="codeks-bridge-capture-${stamp}.json"`,
    "cache-control": "no-store",
  });
  res.write(`{"format":"codeks-bridge-capture","version":1,"exported_at":${exportedAt},"exchanges":[`);
  let first = true;
  for (const exchange of [...inspector.exchanges.values()]) {
    if (res.destroyed) return;
    const chunk = (first ? "" : ",") + JSON.stringify(detail(exchange));
    first = false;
    if (!res.write(chunk)) await drained(res);
  }
  res.end("]}\n");
}
