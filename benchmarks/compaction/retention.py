"""Text-only fixture retention, matching Codex 0.162.1 native V2's 64k budget.

This is a benchmark helper, not the client's general history retention policy.
It accepts ordinary text-only user messages from the synthetic fixture. Media,
contextual messages, hooks, notices, and agent messages are outside its scope.
Developer instructions are supplied separately and do not use this budget.

Reference: openai/codex, codex-rs/core/src/compact_remote_v2.rs and
codex-rs/utils/string/src/truncate.rs at tag rust-v0.162.1 (Apache-2.0).
"""

from __future__ import annotations

import copy

BUDGET = 64_000


def approx_token_count(text: str) -> int:
    return (len(text.encode("utf-8")) + 3) // 4


def truncate_text(text: str, max_tokens: int) -> str:
    """Keep both ends on UTF-8 boundaries; the marker is outside the budget."""
    if max_tokens < 0:
        raise ValueError("The retained token budget must be nonnegative")
    data = text.encode("utf-8")
    budget = max_tokens * 4
    if len(data) <= budget:
        return text
    left = budget // 2
    right_start = len(data) - (budget - left)
    while left and left < len(data) and data[left] & 0xC0 == 0x80:
        left -= 1
    while right_start < len(data) and data[right_start] & 0xC0 == 0x80:
        right_start += 1
    removed = (len(data) - budget + 3) // 4
    return data[:left].decode() + f"…{removed} tokens truncated…" + data[right_start:].decode()


def retained_user_messages(items: list[dict], max_tokens: int = BUDGET) -> tuple[list[dict], dict]:
    """Return oldest-first retained users and counts for synthetic fixtures."""
    if max_tokens < 0:
        raise ValueError("The retained token budget must be nonnegative")
    users = []
    for index, item in enumerate(items):
        if item.get("type") != "message" or item.get("role") != "user":
            continue
        if any(part.get("type") != "input_text" or part["text"].lstrip().startswith("<")
               for part in item["content"]):
            raise ValueError("Fixture retention requires ordinary text-only user messages")
        users.append((index, item))
    remaining, selected, boundary = max_tokens, [], None
    for index, source in reversed(users):
        if remaining == 0:
            continue
        tokens = sum(approx_token_count(part["text"]) for part in source["content"])
        charge = max(tokens, 1)
        if charge <= remaining:
            selected.append((index, copy.deepcopy(source)))
            remaining -= charge
        else:
            item = copy.deepcopy(source)
            content, available = [], remaining
            for part in item["content"]:
                if available == 0:
                    continue
                count = approx_token_count(part["text"])
                if count <= available:
                    available -= count
                else:
                    part["text"] = truncate_text(part["text"], available)
                    available = 0
                if part["text"]:
                    content.append(part)
            if content:
                item["content"] = content
                selected.append((index, item))
                boundary = {"input_index": index, "original_approx_tokens": tokens,
                            "available_tokens": remaining,
                            "retained_approx_tokens_including_marker": sum(approx_token_count(p["text"]) for p in content)}
                remaining = 0
    selected.reverse()
    output = [item for _, item in selected]
    metadata = {"budget": max_tokens, "eligible_user_messages": len(users),
                "eligible_text_bytes": sum(len(p["text"].encode()) for _, m in users for p in m["content"]),
                "eligible_approx_tokens": sum(approx_token_count(p["text"]) for _, m in users for p in m["content"]),
                "retained_user_messages": len(output), "fully_retained_user_messages": len(output) - bool(boundary),
                "dropped_user_messages": len(users) - len(output),
                "retained_input_indices": [index for index, _ in selected],
                "retained_approx_tokens_including_marker": sum(approx_token_count(p["text"]) for m in output for p in m["content"]),
                "boundary": boundary, "remaining_budget": remaining}
    return output, metadata
