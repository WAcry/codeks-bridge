import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeCompaction, encodeCompaction, type CompactionCarrier } from "./carrier.ts";
import { collectHandoff, handoffRequest } from "./compaction.ts";
import { splitCompactionPrefix } from "./compaction-history.ts";
import { resolveModel } from "./config.ts";
import { BridgeError } from "./errors.ts";
import { restoresNativeCompaction } from "./history.ts";
import type { AdapterId, Backend, BackendContext, BridgeConfig, ResolvedModel, ResponsesRequest } from "./types.ts";

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    });
  });
}

/** Successful exports survive restarts; each caller owns only its own cancellation. */
export class CompactionHandoffStore {
  readonly directory: string;
  private readonly config: BridgeConfig;
  private readonly backends: Record<AdapterId, Backend>;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(config: BridgeConfig, backends: Record<AdapterId, Backend>) {
    this.config = config;
    this.backends = backends;
    this.directory = config.compaction_cache_dir ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "codeks-bridge", "compaction");
  }

  private source(carrier: CompactionCarrier): ResolvedModel {
    const preferred = carrier.handoff!.parameters.model;
    const aliases = [...new Set([preferred, ...Object.keys(this.config.models)])];
    for (const alias of aliases) {
      if (!Object.hasOwn(this.config.models, alias)) continue;
      const route = resolveModel(this.config, alias);
      if (route.origin.id === carrier.native!.source.id) return route;
    }
    throw new BridgeError("The original compaction source is not configured; restore its model and upstream to generate a handoff.");
  }

  private async summary(carrier: CompactionCarrier, request: ResponsesRequest, context: BackendContext): Promise<string> {
    const { signal } = context;
    const key = createHash("sha256").update(JSON.stringify({
      source: carrier.native!.source,
      request,
      responsesLite: carrier.handoff!.responsesLite,
    })).digest("hex");
    const previous = this.pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.pending.set(key, tail);
    void tail.then(() => { if (this.pending.get(key) === tail) this.pending.delete(key); });
    try {
      await waitForTurn(previous, signal);
      const path = join(this.directory, `${key}.json`);
      try {
        const cached = JSON.parse(await readFile(path, "utf8"));
        if (typeof cached.summary !== "string" || !cached.summary.trim()) throw new BridgeError("Invalid cached compaction handoff.");
        signal.throwIfAborted();
        return cached.summary;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      signal.throwIfAborted();
      const route = this.source(carrier);
      const result = await collectHandoff({
        request: { ...request, model: route.slug }, route, signal,
        requestHeaders: context.requestHeaders,
        responsesLite: carrier.handoff!.responsesLite,
      }, this.backends[route.profile.id]);
      signal.throwIfAborted();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `.${key}.${randomUUID()}.tmp`);
      try {
        // Usage belongs to this export, never to the destination model's context.
        await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
      signal.throwIfAborted();
      return result.summary;
    } finally {
      release();
    }
  }

  /** Only checkpoint predecessors enter the export; later work stays on the target. */
  async materialize(context: BackendContext): Promise<ResponsesRequest> {
    if (!Array.isArray(context.request.input)) return context.request;
    let changed = false;
    const input = context.request.input;
    const prepared = [...input];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      if (item.type !== "compaction" && item.type !== "compaction_summary") continue;
      const carrier = decodeCompaction(item.encrypted_content);
      if (!carrier || carrier.summary !== undefined || restoresNativeCompaction(carrier, context.route)) continue;
      if (!carrier.native || !carrier.handoff) throw new BridgeError("This compaction checkpoint has no handoff recipe.");
      const { history } = splitCompactionPrefix(input.slice(0, i));
      const request = handoffRequest(carrier.handoff, history, item);
      const summary = await this.summary(carrier, request, context);
      prepared[i] = { ...item, encrypted_content: encodeCompaction({ ...carrier, summary }) };
      changed = true;
    }
    return changed ? { ...context.request, input: prepared } : context.request;
  }
}
