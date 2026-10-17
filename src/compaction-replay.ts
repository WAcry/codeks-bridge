import { createHash } from "node:crypto";
import { decodeCompaction } from "./carrier.ts";
import type { ResolvedModel, ResponsesRequest } from "./types.ts";

export interface CompactionReplay {
  readonly useSummary: boolean;
  rememberSummary(): void;
}

/** Remembers successful fallback within a turn, target, and checkpoint set. */
export class CompactionReplayCache {
  private readonly summaries = new Set<string>();

  forRequest(request: ResponsesRequest, route: ResolvedModel): CompactionReplay {
    const metadata = request.client_metadata;
    const checkpoints = Array.isArray(request.input)
      ? request.input.flatMap((item) => {
        if (item?.type !== "compaction" && item?.type !== "compaction_summary") return [];
        const native = decodeCompaction(item.encrypted_content)?.native;
        return native ? [native.item.encrypted_content] : [];
      })
      : [];
    const hasTurn = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      && typeof metadata.thread_id === "string" && metadata.thread_id.trim()
      && typeof metadata.turn_id === "string" && metadata.turn_id.trim();
    // Sort object keys so equivalent configuration aliases have the same identity.
    // Only the hash is retained, never headers or checkpoint payloads.
    const key = hasTurn && checkpoints.length ? createHash("sha256").update(JSON.stringify([
      metadata.thread_id, metadata.turn_id, route.key,
      route.upstream.headers, route.upstream.options, route.config.options, checkpoints,
    ], (_name, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]]))
      : value)).digest("hex") : undefined;
    const summaries = this.summaries;
    let local = false;
    return {
      get useSummary() { return local || (key !== undefined && summaries.has(key)); },
      rememberSummary() {
        local = true;
        if (key === undefined || summaries.has(key)) return;
        summaries.add(key);
        // FIFO bounds memory without depending on a turn completion notification.
        if (summaries.size > 256) summaries.delete(summaries.values().next().value!);
      },
    };
  }
}
