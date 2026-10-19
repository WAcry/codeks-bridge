type Item = Record<string, any>;
const isMessage = (item: Item): boolean => item.type === "message" || (!item.type && typeof item.role === "string");

/** Save source instructions and Lite declarations, without saving old conversation turns. */
export function splitCompactionPrefix(input: readonly Item[]): { prefix: Item[]; history: Item[] } {
  const prefix: Item[] = [];
  const history: Item[] = [];
  let leading = true;
  for (const item of input) {
    if (item.type === "additional_tools") {
      prefix.push(item);
    } else if (leading && isMessage(item) && ["system", "developer"].includes(item.role)) {
      prefix.push(item);
    } else {
      leading = false;
      history.push(item);
    }
  }
  return { prefix, history };
}

const tokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 4);
const textPart = (part: Item): boolean => part.type === "input_text" || part.type === "output_text";
const contentParts = (item: Item): Item[] => typeof item.content === "string"
  ? [{ type: "input_text", text: item.content }]
  : item.content;

function contentTokens(part: Item): number {
  if (textPart(part)) return tokens(part.text);
  // Codex's resized-image estimate; original detail uses its conservative patch ceiling.
  // Inline original images can cost less when the client can inspect their dimensions.
  if (part.type === "input_image") return part.detail === "original" ? 10_000 : 1_844;
  return 0;
}

function itemTokens(item: Item): number {
  if (item.type === "agent_message") {
    return Math.ceil((Buffer.byteLength(item.author) + Buffer.byteLength(item.recipient) +
      contentParts(item).reduce((bytes: number, part: Item) => bytes + Buffer.byteLength(part.text ?? ""), 0)) / 4);
  }
  return contentParts(item).reduce((sum: number, part: Item) => sum + contentTokens(part), 0);
}

const CONTEXT_MARKERS = [
  ["# AGENTS.md instructions", "</INSTRUCTIONS>"],
  ["<environment_context>", "</environment_context>"],
  ["<agent_message_board_notification>", "</agent_message_board_notification>"],
  ["<skill>", "</skill>"],
  ["<user_shell_command>", "</user_shell_command>"],
  ["<turn_aborted>", "</turn_aborted>"],
  ["<subagent_notification>", "</subagent_notification>"],
  ["<recommended_plugins>", "</recommended_plugins>"],
] as const;

function contextualText(text: string): boolean {
  const value = text.trim();
  const lower = value.toLowerCase();
  const external = /^<external_([^>]+)>/.exec(value);
  return CONTEXT_MARKERS.some(([start, end]) => lower.startsWith(start.toLowerCase()) && lower.endsWith(end.toLowerCase())) ||
    !!(external && value.endsWith(`</external_${external[1]}>`)) ||
    (value.startsWith("<goal_context>") && value.endsWith("</goal_context>")) ||
    /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/.test(value) ||
    value.startsWith("Warning: The maximum number of unified exec processes you can keep open is") ||
    value.startsWith("Warning: Your account was flagged for potentially high-risk cyber activity") ||
    (value.startsWith("Warning: apply_patch was requested via ") &&
      value.endsWith("Use the apply_patch tool instead of exec_command."));
}

function hookText(text: string): boolean {
  return /^<hook_prompt hook_run_id="[^"\s][^"]*">[\s\S]*<\/hook_prompt>$/.test(text.trim());
}

function retained(item: Item): boolean {
  if (item.type === "agent_message") {
    const text = item.content[0]?.type === "input_text" ? item.content[0].text : "";
    const progress = item.author.startsWith(`${item.recipient}/`) &&
      (text.startsWith("Message Type: MESSAGE\n") || text.startsWith("Message Type: CHANNEL_POST\n"));
    return !progress && !text.startsWith("Message Type: FINAL_ANSWER\n") && itemTokens(item) <= 10_000;
  }
  if (!isMessage(item) || item.role !== "user") return false;
  const content = contentParts(item);
  const visibleHook = content.some((part: Item) => part.type === "input_text" && hookText(part.text)) &&
    content.every((part: Item) => part.type === "input_text" && (hookText(part.text) || contextualText(part.text)));
  return visibleHook || !content.some((part: Item) =>
    part.type === "input_text" && (contextualText(part.text) || hookText(part.text)));
}

function resizeNotice(item: Item | undefined): boolean {
  if (!item || !isMessage(item) || item.role !== "developer") return false;
  const content = contentParts(item);
  if (content.length !== 1) return false;
  const part = content[0];
  const text = part.type === "input_text" ? part.text.trim().toLowerCase() : "";
  return text.startsWith("<image_resize_notice>") && text.endsWith("</image_resize_notice>");
}

/** Codex keeps both ends of a boundary text; the truncation marker is outside the budget. */
function truncateText(text: string, budget: number): string {
  const bytes = Buffer.from(text);
  const limit = budget * 4;
  if (bytes.length <= limit) return text;
  let left = Math.floor(limit / 2);
  let right = bytes.length - (limit - left);
  while (left > 0 && (bytes[left] & 0xc0) === 0x80) left--;
  while (right < bytes.length && (bytes[right] & 0xc0) === 0x80) right++;
  return `${bytes.subarray(0, left).toString()}…${Math.ceil((bytes.length - limit) / 4)} tokens truncated…${bytes.subarray(right).toString()}`;
}

function truncateMessage(item: Item, budget: number): Item | undefined {
  if (!isMessage(item)) return undefined;
  const parts = contentParts(item);
  const hasImages = parts.some((part: Item) => part.type === "input_image");
  const content: Item[] = [];
  const pending: Item[] = [...parts];
  // Text-only messages keep their first parts; image boundaries prefer recent parts.
  while (pending.length) {
    const part = hasImages ? pending.pop()! : pending.shift()!;
    const closing = part.type === "input_text" && part.text === "</image>" && pending.at(-1)?.type === "input_image";
    if (hasImages && (part.type === "input_image" || closing)) {
      const group = [part];
      if (closing) group.unshift(pending.pop()!);
      const before = pending.at(-1);
      if (before?.type === "input_text" && (before.text === "<image>" || /^<image name=.*>$/.test(before.text))) {
        group.unshift(pending.pop()!);
      }
      const cost = group.reduce((sum, value) => sum + contentTokens(value), 0);
      if (cost <= budget) {
        content.push(...group.toReversed());
        budget -= cost;
      } else {
        budget = 0;
      }
    } else if (textPart(part)) {
      if (!budget) continue;
      const text = truncateText(part.text, budget);
      budget = Math.max(0, budget - contentTokens(part));
      if (text) content.push({ ...part, text });
    } else {
      content.push(part);
    }
  }
  if (hasImages) content.reverse();
  return content.length ? { ...item, content } : undefined;
}

/**
 * Retain observable default Codeks v0.163 messages for an eager handoff.
 * Client-only retention flags and metadata are not sent over the wire. A lazy
 * handoff instead uses the actual client-retained items without running this again.
 */
export function retainedCompactionHistory(input: readonly Item[], maxTokens = 64_000): Item[] {
  const groups: { item: Item; notice?: Item }[] = [];
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    const notice = resizeNotice(input[index + 1]) ? input[++index] : undefined;
    if (retained(item)) groups.push({ item, notice });
  }
  const result: Item[] = [];
  let remaining = maxTokens;
  for (const { item, notice } of groups.toReversed()) {
    if (remaining <= 0) break;
    const noticeCost = notice ? Math.max(1, itemTokens(notice)) : 0;
    const cost = Math.max(1, itemTokens(item)) + noticeCost;
    if (cost <= remaining) {
      if (notice) result.push(notice);
      result.push(item);
      remaining -= cost;
    } else if (remaining > noticeCost) {
      const boundary = truncateMessage(item, remaining - noticeCost);
      if (contentParts(item).some((part: Item) => part.type === "input_image")) remaining = 0;
      if (!boundary) continue;
      if (notice) result.push(notice);
      result.push(boundary);
      remaining = 0;
    } else if (contentParts(item).some((part: Item) => part.type === "input_image")) {
      remaining = 0;
    }
  }
  return result.reverse();
}
