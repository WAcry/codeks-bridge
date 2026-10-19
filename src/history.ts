import { decodeCompaction, decodeReasoning, type CompactionCarrier, type StatePayload } from "./carrier.ts";
import { BridgeError } from "./errors.ts";
import { SUMMARY_PREFIX } from "./prompts.ts";
import { translateToolHistory } from "./tool-history.ts";
import type { ResolvedModel, ResponsesRequest } from "./types.ts";

/** Replay policy for decoded state. The inspector reports the same decisions. */
export function replaysReasoning(carrier: StatePayload, route: ResolvedModel): boolean {
  return route.replay.reasoning.has(carrier.source.id) && carrier.format === route.profile.reasoning_format;
}
export function restoresNativeCompaction(carrier: CompactionCarrier, route: ResolvedModel): boolean {
  return !!carrier.native && route.compaction.native_replay &&
    route.replay.native_compaction.has(carrier.native.source.id) &&
    carrier.native.format === route.profile.native_compaction_format;
}

/** Selects model-specific opaque state without changing the stored history. */
export function prepareHistory(input: ResponsesRequest["input"], route: ResolvedModel): Record<string, any>[] {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new BridgeError("input must be a string or an array of items");

  const result: Record<string, any>[] = [];
  for (const original of input) {
    if (!original || typeof original !== "object" || Array.isArray(original)) {
      throw new BridgeError("Each input item must be an object");
    }
    const item = structuredClone(original);
    if (item.type === "bridge_reasoning") {
      throw new BridgeError("Internal reasoning items cannot be supplied as request history");
    }
    if (item.type === "item_reference") {
      throw new BridgeError("Stored item references are unsupported; send the complete conversation items");
    }
    if (item.type === "reasoning") {
      const carrier = decodeReasoning(item.encrypted_content);
      if (carrier && replaysReasoning(carrier, route)) {
        result.push({ type: "bridge_reasoning", state: carrier, summary: item.summary ?? [] });
      }
      continue;
    }
    if (item.type === "agent_message" && route.profile.api !== "responses") {
      if (typeof item.author !== "string" || typeof item.recipient !== "string" || !Array.isArray(item.content)) {
        throw new BridgeError("An agent message requires author, recipient, and content");
      }
      if (item.encrypted_content || item.content.some((part: any) => part?.type === "encrypted_content")) {
        throw new BridgeError("Encrypted agent messages are unsupported on this backend; use plaintext agent messages");
      }
      for (const part of item.content) {
        if (!["input_text", "input_image"].includes(part?.type)) {
          throw new BridgeError(`Unsupported agent message content: ${String(part?.type)}`);
        }
      }
      result.push({
        type: "message", role: "user",
        content: [
          { type: "input_text", text: `Agent message from ${JSON.stringify(item.author)} to ${JSON.stringify(item.recipient)}:\n` },
          ...item.content,
        ],
      });
      continue;
    }
    if (item.type === "compaction" || item.type === "compaction_summary") {
      const carrier = decodeCompaction(item.encrypted_content);
      if (!carrier) {
        throw new BridgeError("This compaction item has no portable summary or handoff recipe; use history created through this bridge");
      }
      if (restoresNativeCompaction(carrier, route)) {
        result.push(carrier.native!.data as Record<string, any>);
      } else {
        if (!carrier.summary) throw new BridgeError("Deferred compaction summary has not been materialized");
        result.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${carrier.summary}` }],
        });
      }
      continue;
    }
    result.push(item);
  }
  return route.profile.api === "responses" ? result : translateToolHistory(result);
}
