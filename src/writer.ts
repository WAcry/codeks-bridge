// Writes an OpenAI Responses SSE stream for codeks.
//
// Rules that codeks depends on (see docs/responses-stream.md):
// - every item gets output_item.added before any delta, and output_item.done
//   with the complete item; codeks records history from the done event;
// - response.completed carries the response id and a complete usage object;
// - errors go into response.failed, never into a bare "error" event.

import { formatSse } from "./sse.ts";
import { newId } from "./ids.ts";
import { BridgeError } from "./errors.ts";

export interface Usage {
  input_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  output_tokens: number;
  reasoning_tokens?: number;
}

export interface Sink {
  write(chunk: string): void;
}

export interface FunctionCallItem {
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
}

export interface CustomToolCallItem {
  call_id: string;
  name: string;
  input: string;
  namespace?: string;
}

type Phase = "commentary" | "partial_answer" | "final_answer";

interface OpenMessage {
  id: string;
  outputIndex: number;
  text: string;
  phase?: Phase;
}

interface SummaryPart {
  text: string;
  done: boolean;
}

interface OpenReasoning {
  id: string;
  outputIndex: number;
  summary: Map<number, SummaryPart>;
}

export function usageJson(usage: Usage): Record<string, unknown> {
  const input = Math.max(0, Math.round(usage.input_tokens));
  const output = Math.max(0, Math.round(usage.output_tokens));
  const out: Record<string, unknown> = {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: Math.max(0, Math.round(usage.cached_tokens ?? 0)),
      ...(usage.cache_write_tokens ? { cache_write_tokens: Math.round(usage.cache_write_tokens) } : {}),
    },
    output_tokens: output,
    total_tokens: input + output,
  };
  if (usage.reasoning_tokens !== undefined) {
    out.output_tokens_details = { reasoning_tokens: Math.max(0, Math.round(usage.reasoning_tokens)) };
  }
  return out;
}

export class ResponseWriter {
  private id: string;
  private readonly sink: Sink;
  private readonly model: string;
  private readonly showSummary: boolean;
  private seq = 0;
  private nextOutputIndex = 0;
  private readonly output: unknown[] = [];
  private message: OpenMessage | undefined;
  private reasoning: OpenReasoning | undefined;
  // A finished message waits here until we know whether a tool call follows.
  private pendingMessage: OpenMessage | undefined;
  private calls = 0;
  // Once a tool appears, preserve its entire ordered suffix until success.
  private suffix: Array<{ event: Record<string, any>; native: boolean }> | undefined;
  private suffixOutputStart = 0;
  private native = false;
  private nativeEnd: Record<string, any> | undefined;
  private started = false;
  private finished = false;

  constructor(sink: Sink, opts: { model: string; showSummary?: boolean; responseId?: string }) {
    this.sink = sink;
    this.model = opts.model;
    this.showSummary = opts.showSummary ?? true;
    this.id = opts.responseId ?? newId("resp");
  }

  get responseId(): string { return this.id; }

  get nativeResponse(): Record<string, any> | undefined { return this.nativeEnd?.response; }

  get outputItems(): readonly Record<string, any>[] {
    return this.output as Record<string, any>[];
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get hasOutput(): boolean {
    return this.nextOutputIndex > 0 || this.calls > 0 || this.message !== undefined;
  }

  private write(event: Record<string, any>, native = false): void {
    this.sink.write(formatSse(native ? event : { sequence_number: this.seq++, ...event }));
  }

  private send(event: Record<string, any>, native = false): void {
    if (this.suffix) this.suffix.push({ event, native });
    else this.write(event, native);
  }

  private emit(type: string, fields: Record<string, unknown>): void {
    this.send({ type, ...fields });
  }

  private holdSuffix(): void {
    if (this.suffix) return;
    this.suffix = [];
    this.suffixOutputStart = this.output.length;
  }

  private releaseSuffix(): void {
    const suffix = this.suffix;
    this.suffix = undefined;
    for (const { event, native } of suffix ?? []) this.write(event, native);
  }

  private discardSuffix(): void {
    if (this.suffix) this.output.length = this.suffixOutputStart;
    this.suffix = undefined;
    this.message = undefined;
    this.reasoning = undefined;
    this.pendingMessage = undefined;
    this.calls = 0;
  }

  private responseObject(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: this.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.model,
      status,
      output: status === "in_progress" ? [] : this.output,
      ...extra,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.native) this.emit("response.created", { response: this.responseObject("in_progress") });
  }

  /** An event that codeks ignores but that resets its stream idle timer. */
  keepalive(): void {
    if (!this.started || this.finished) return;
    // Heartbeats bypass an ordered suffix while the upstream is still working.
    this.write({ type: "keepalive" }, this.native);
  }

  /** Native Responses events retain their own ids, envelopes and metadata. */
  useNativeResponses(): void { this.native = true; }

  nativeEvent(event: Record<string, any>): void {
    if (this.finished) return;
    if (typeof event.response?.id === "string") this.id = event.response.id;
    if (event.type === "response.completed") {
      this.nativeEnd = event;
      return;
    }
    if (["response.output_item.added", "response.output_item.done"].includes(event.type)) {
      if (["function_call", "custom_tool_call"].includes(event.item?.type)) this.holdSuffix();
      if (event.type === "response.output_item.done") this.output.push(event.item);
      this.nextOutputIndex = Math.max(this.nextOutputIndex, Number(event.output_index ?? 0) + 1);
    }
    this.send(event, true);
  }

  nativeFailed(response: Record<string, any>, event: Record<string, any> = {}): void {
    this.nativeFailure("response.failed", response, event);
  }

  nativeIncomplete(response: Record<string, any>, event: Record<string, any> = {}): void {
    this.nativeFailure("response.incomplete", response, event);
  }

  private nativeFailure(type: string, response: Record<string, any>, event: Record<string, any>): void {
    if (this.finished) return;
    this.discardSuffix();
    this.finished = true;
    if (typeof response.id === "string") this.id = response.id;
    this.nativeEnd = { ...event, type, response };
    this.write(this.nativeEnd, true);
  }

  // Reasoning -----------------------------------------------------------

  private openReasoning(): OpenReasoning {
    if (this.reasoning) return this.reasoning;
    this.closeMessage();
    this.flushPendingMessage("commentary");
    const r: OpenReasoning = { id: newId("rs"), outputIndex: this.nextOutputIndex++, summary: new Map() };
    this.reasoning = r;
    this.emit("response.output_item.added", {
      output_index: r.outputIndex,
      item: { type: "reasoning", id: r.id, summary: [], encrypted_content: null },
    });
    return r;
  }

  startReasoningSummary(summaryIndex = 0): void {
    const r = this.openReasoning();
    if (!this.showSummary || r.summary.has(summaryIndex)) return;
    r.summary.set(summaryIndex, { text: "", done: false });
    this.emit("response.reasoning_summary_part.added", {
      item_id: r.id,
      output_index: r.outputIndex,
      summary_index: summaryIndex,
      part: { type: "summary_text", text: "" },
    });
  }

  reasoningDelta(text: string, summaryIndex = 0): void {
    const r = this.openReasoning();
    if (!text || !this.showSummary) return;
    this.startReasoningSummary(summaryIndex);
    const part = r.summary.get(summaryIndex)!;
    if (part.done) throw new BridgeError("The upstream changed a completed reasoning summary", "stream_error", 502);
    part.text += text;
    this.emit("response.reasoning_summary_text.delta", {
      item_id: r.id,
      output_index: r.outputIndex,
      summary_index: summaryIndex,
      delta: text,
    });
  }

  endReasoningSummary(summaryIndex = 0, text?: string): void {
    const r = this.openReasoning();
    if (!this.showSummary) return;
    this.startReasoningSummary(summaryIndex);
    const part = r.summary.get(summaryIndex)!;
    if (text !== undefined) {
      if (!text.startsWith(part.text)) {
        throw new BridgeError("The upstream changed already streamed reasoning summary", "stream_error", 502);
      }
      this.reasoningDelta(text.slice(part.text.length), summaryIndex);
    }
    if (part.done) return;
    part.done = true;
    this.emit("response.reasoning_summary_text.done", {
      item_id: r.id,
      output_index: r.outputIndex,
      summary_index: summaryIndex,
      text: part.text,
    });
    this.emit("response.reasoning_summary_part.done", {
      item_id: r.id,
      output_index: r.outputIndex,
      summary_index: summaryIndex,
      part: { type: "summary_text", text: part.text },
    });
  }

  /** Closes the open reasoning item (opening one if needed) with its carrier. */
  endReasoning(encryptedContent: string | undefined, summary?: Array<{ type: "summary_text"; text: string }>): void {
    const r = this.openReasoning();
    for (const [index, part] of (summary ?? []).entries()) this.endReasoningSummary(index, part.text);
    for (const index of r.summary.keys()) this.endReasoningSummary(index);
    const item = {
      type: "reasoning",
      id: r.id,
      summary: [...r.summary.entries()].sort(([a], [b]) => a - b)
        .map(([, part]) => ({ type: "summary_text", text: part.text })),
      encrypted_content: encryptedContent ?? null,
    };
    this.reasoning = undefined;
    this.emit("response.output_item.done", { output_index: r.outputIndex, item });
    this.output.push(item);
  }

  get reasoningOpen(): boolean {
    return this.reasoning !== undefined;
  }

  // Messages ------------------------------------------------------------

  textDelta(text: string, phase?: Phase): void {
    if (this.message && phase !== undefined) this.message.phase = phase;
    if (!text) return;
    if (this.reasoning) this.endReasoning(undefined);
    if (!this.message) {
      this.flushPendingMessage("commentary");
      const m: OpenMessage = { id: newId("msg"), outputIndex: this.nextOutputIndex++, text: "", phase };
      this.message = m;
      this.emit("response.output_item.added", {
        output_index: m.outputIndex,
        item: { type: "message", id: m.id, role: "assistant", status: "in_progress", content: [], ...(phase !== undefined ? { phase } : {}) },
      });
      this.emit("response.content_part.added", {
        item_id: m.id,
        output_index: m.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.message.text += text;
    this.emit("response.output_text.delta", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  /** Ends the current text block. Its done event waits until the phase is known. */
  closeMessage(phase?: Phase): void {
    if (!this.message) return;
    if (phase !== undefined) this.message.phase = phase;
    this.flushPendingMessage("commentary");
    this.pendingMessage = this.message;
    this.message = undefined;
  }

  private flushPendingMessage(phase: Phase): void {
    const m = this.pendingMessage;
    if (!m) return;
    this.pendingMessage = undefined;
    const item = {
      type: "message",
      id: m.id,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: m.text, annotations: [] }],
      phase: m.phase ?? phase,
    };
    this.emit("response.output_text.done", {
      item_id: m.id,
      output_index: m.outputIndex,
      content_index: 0,
      text: m.text,
    });
    this.emit("response.output_item.done", { output_index: m.outputIndex, item });
    this.output.push(item);
  }

  // Tool calls (held until the upstream response finishes) ---------------

  addFunctionCall(call: FunctionCallItem): void {
    this.closeMessage();
    if (this.reasoning) this.endReasoning(undefined);
    const item: Record<string, unknown> = {
      type: "function_call",
      id: newId("fc"),
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments,
      encrypted_function_args: [],
      status: "completed",
    };
    if (call.namespace) item.namespace = call.namespace;
    this.addTool(item);
  }

  addCustomToolCall(call: CustomToolCallItem): void {
    this.closeMessage();
    if (this.reasoning) this.endReasoning(undefined);
    this.addTool({
      type: "custom_tool_call",
      id: newId("ctc"),
      call_id: call.call_id,
      name: call.name,
      input: call.input,
      ...(call.namespace ? { namespace: call.namespace } : {}),
      status: "completed",
    });
  }

  private addTool(item: Record<string, unknown>): void {
    this.flushPendingMessage("commentary");
    this.holdSuffix();
    this.calls++;
    const outputIndex = this.nextOutputIndex++;
    const added: Record<string, unknown> = { ...item, status: "in_progress" };
    if (item.type === "function_call") added.arguments = "";
    else added.input = "";
    this.emit("response.output_item.added", { output_index: outputIndex, item: added });
    this.emit("response.output_item.done", { output_index: outputIndex, item });
    this.output.push(item);
  }

  get toolCallCount(): number {
    return this.output.slice(0, this.suffix ? this.suffixOutputStart : undefined)
      .filter((item: any) => ["function_call", "custom_tool_call"].includes(item.type)).length;
  }

  /** Emits a complete item as-is (added and done together). */
  addItem(item: Record<string, unknown>): void {
    this.closeMessage();
    this.flushPendingMessage("commentary");
    if (this.reasoning) this.endReasoning(undefined);
    const outputIndex = this.nextOutputIndex++;
    this.emit("response.output_item.added", { output_index: outputIndex, item });
    this.emit("response.output_item.done", { output_index: outputIndex, item });
    this.output.push(item);
  }

  private flushAll(endTurn?: boolean): void {
    this.closeMessage();
    if (this.reasoning) this.endReasoning(undefined);
    this.flushPendingMessage(endTurn === false || this.calls > 0 ? "commentary" : "final_answer");
  }

  // Endings ---------------------------------------------------------------

  complete(usage: Usage | undefined, endTurn?: boolean): void {
    if (this.finished) return;
    this.start();
    if (this.nativeEnd) {
      this.releaseSuffix();
      this.finished = true;
      this.write(this.nativeEnd, true);
      return;
    }
    if (this.native) throw new BridgeError("The upstream stream ended before response.completed", "stream_error", 502);
    this.flushAll(endTurn);
    this.releaseSuffix();
    this.finished = true;
    const extra: Record<string, unknown> = {};
    if (usage) extra.usage = usageJson(usage);
    if (endTurn !== undefined) extra.end_turn = endTurn;
    this.emit("response.completed", { response: this.responseObject("completed", extra) });
  }

  /** Fails the response. Tool calls that were not emitted yet are dropped. */
  fail(error: Record<string, unknown>): void {
    if (this.finished) return;
    this.start();
    this.discardSuffix();
    this.finished = true;
    this.emit("response.failed", {
      response: this.responseObject("failed", { error }),
    });
  }

  incomplete(reason: string, usage: Usage | undefined): void {
    if (this.finished) return;
    this.start();
    if (this.suffix) this.discardSuffix();
    this.closeMessage();
    if (this.reasoning) this.endReasoning(undefined);
    this.flushPendingMessage("final_answer");
    this.finished = true;
    const extra: Record<string, unknown> = { incomplete_details: { reason } };
    if (usage) extra.usage = usageJson(usage);
    this.emit("response.incomplete", { response: this.responseObject("incomplete", extra) });
  }
}
