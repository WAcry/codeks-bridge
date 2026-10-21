"""Controlled Codex fixtures adapted from algal's product-defaults benchmark.

Reference: https://github.com/algal/pi-openai-server-compaction/blob/
8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/benchmarks/product-defaults/fixtures.ts

The reference's five ledgers, ten epochs, hash-derived values, correction
semantics, and evenly spaced hidden question selection are preserved. This
adapter uses canonical Responses items, exact local o200k_base JSON token
padding, thirty probes per category, and five absent-field probes. Token counts
are local serialized-input counts, not a claim about server billing tokens.

MIT License

Copyright (c) 2026 Alexis Gallagher

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import tiktoken

from retention import retained_user_messages

ENCODING = tiktoken.get_encoding("o200k_base")
CATEGORIES = (
    "exact_recall", "relational_state", "tool_history",
    "distractor_resolution", "task_continuation",
)
STATES = ("DONE", "IN_PROGRESS", "BLOCKED", "QUEUED", "VERIFYING")
REFERENCE_COMMIT = "8a3de2f3b0c178fdd6f73f2f94172dfc3943e466"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def count_tokens(value: Any) -> int:
    return len(ENCODING.encode(_json(value), disallowed_special=()))


def digest(seed: int, namespace: str, index: int) -> str:
    return hashlib.sha256(f"product-defaults-v1:{seed}:{namespace}:{index}".encode()).hexdigest()


def nonce(seed: int, namespace: str, index: int, length: int = 20) -> str:
    return digest(seed, namespace, index)[:length]


def user(text: str) -> dict[str, Any]:
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def assistant(text: str) -> dict[str, Any]:
    return {
        "type": "message", "role": "assistant", "phase": "final_answer",
        "content": [{"type": "output_text", "text": text}],
    }


def _filler(seed: int, epoch: int, tokens: int) -> str:
    """Build answer-free archival text, clipped only inside archival material."""
    header = f"UNRELATED ARCHIVAL MATERIAL FOR EPOCH {epoch}. Ignore it for active-project continuation."
    fragments = [header]
    approximate = len(ENCODING.encode(header))
    index = 0
    while approximate < tokens + 80:
        fragment = (
            f" Archive notebook {epoch}-{index} is unrelated to the active project. "
            f"Its obsolete simulation values {nonce(seed + epoch, 'archive-a', index, 16)} "
            f"and {nonce(seed + epoch, 'archive-b', index, 16)} are non-authoritative; "
            "they update no active key, route, tool result, correction, or task checkpoint."
        )
        fragments.append(fragment)
        approximate += len(ENCODING.encode(fragment))
        index += 1
    encoded = ENCODING.encode("".join(fragments), disallowed_special=())
    return ENCODING.decode(encoded[:tokens])


def _pad_epochs(epoch_messages: list[list[dict]], seed: int, target: int) -> list[dict]:
    core = [item for epoch in epoch_messages for item in epoch]
    core_count = count_tokens(core)
    if core_count > target:
        raise ValueError(f"Authoritative core is {core_count} local tokens, above target {target}")
    # All densities have the same archival-message framing. Only filler content
    # changes, and each epoch receives an equal share of the padding budget.
    history: list[dict] = []
    fillers: list[dict] = []
    for epoch, messages in enumerate(epoch_messages):
        history.extend(messages)
        filler = user("")
        fillers.append(filler)
        history.extend([filler, assistant(f"Archived epoch {epoch}; active-project state is unchanged.")])
    remaining = target - count_tokens(history)
    if remaining < len(epoch_messages) * 40:
        raise ValueError(f"Target {target} leaves insufficient archival framing space above core {core_count}")
    for epoch, filler in enumerate(fillers):
        allocation = remaining // len(fillers) + int(epoch < remaining % len(fillers))
        filler["content"][0]["text"] = _filler(seed, epoch, allocation)
    # JSON/BPE boundaries can change a few tokens. Keep the final correction in
    # the last non-authoritative notebook, never in an authoritative record.
    final_encoded = ENCODING.encode(fillers[-1]["content"][0]["text"], disallowed_special=())
    final_text = ENCODING.decode(final_encoded[:-64]) + " Archive padding:"
    fillers[-1]["content"][0]["text"] = final_text + "."
    count = target - count_tokens(history)
    for _ in range(5):
        fillers[-1]["content"][0]["text"] = final_text + " archived" * count + "."
        difference = target - count_tokens(history)
        if difference == 0:
            return history
        count += difference
    raise AssertionError(f"Could not pad to exact local size {target}; reached {count_tokens(history)}")


def build_fixture(
    seed: int, density: int, target_tokens: int = 220_000,
    questions_per_category: int = 30, epochs: int = 10,
    retained_tokens: int | None = None,
) -> dict[str, Any]:
    if seed < 1 or questions_per_category < 1 or density < questions_per_category or epochs < 2:
        raise ValueError("Require seed >= 1, density >= questions_per_category >= 1, and epochs >= 2")
    fixture_id = f"codex-s{seed}-d{density}-t{target_tokens}"
    epoch_messages: list[list[dict]] = [[] for _ in range(epochs)]
    candidates: list[dict] = []
    all_payloads: list[str] = []

    def add(category: str, epoch: int, question: str, expected: str, payloads: list[str]) -> None:
        candidates.append({"category": category, "epoch": epoch, "question": question, "expected": expected})
        all_payloads.extend(payloads)

    for epoch in range(epochs):
        messages = epoch_messages[epoch]
        indexes = [i for i in range(density) if i % epochs == epoch]
        exact, routes, obsolete, corrections, tasks = [], [], [], [], []
        calls, results = [], []
        for index in indexes:
            key = f"parameter-{seed}-{index + 1}"
            value = f"value-{nonce(seed, 'exact', index, 24)}"
            exact.append(f"{key}={value}")
            add("exact_recall", epoch, f"What is the exact authoritative value of {key}?", value, [value])

            source = f"route-source-{seed}-{index + 1}"
            target = f"route-target-{nonce(seed, 'relation', index, 22)}"
            routes.append(f"{source}->{target}")
            add("relational_state", epoch, f"Where does {source} route directly?", target, [target])

            probe = f"probe-{seed}-{index + 1}"
            call_id = f"call-{seed}-{index + 1}-{nonce(seed, 'call', index, 8)}"
            result = f"probe-result-{nonce(seed, 'tool', index, 26)}"
            calls.append({"type": "function_call", "call_id": call_id, "name": "database_query", "arguments": _json({"project": seed, "probe": probe})})
            results.append({"type": "function_call_output", "call_id": call_id, "output": f"AUTHORITATIVE TOOL OUTPUT {probe}={result}"})
            add("tool_history", epoch, f"What exact authoritative output value did {probe} return?", result, [result])

            field = f"corrected-field-{seed}-{index + 1}"
            old = f"obsolete-{nonce(seed, 'obsolete', index, 20)}"
            final = f"final-{nonce(seed, 'final', index, 24)}"
            obsolete.append(f"{field}={old}")
            corrections.append(f"{field}={final}")
            add("distractor_resolution", epoch, f"What is the final authoritative value of {field}?", final, [final])

            task = f"work-item-{seed}-{index + 1}"
            state = STATES[int(digest(seed, "state", index)[:8], 16) % len(STATES)]
            receipt = f"receipt-{nonce(seed, 'receipt', index, 18)}"
            next_action = f"next-{nonce(seed, 'next', index, 18)}"
            canonical = f"{state}|receipt={receipt}|next={next_action}"
            tasks.append(f"{task}:{canonical}")
            add("task_continuation", epoch, f"What is the exact current checkpoint for {task}? Return STATE|receipt=VALUE|next=VALUE.", canonical, [receipt, next_action])

        messages.extend([
            user(f"AUTHORITATIVE EXACT LEDGER, epoch {epoch}: {'; '.join(exact)}. Preserve every key and value exactly."),
            assistant(f"Recorded the authoritative exact ledger for epoch {epoch}."),
            user(f"AUTHORITATIVE DIRECTED ROUTES, epoch {epoch}: {'; '.join(routes)}. Every arrow is directional and current."),
            assistant(f"Recorded the authoritative routing graph for epoch {epoch}."),
            assistant(f"Running authoritative probes for epoch {epoch}."),
            *calls, *results,
            assistant(f"All authoritative epoch {epoch} probe results were recorded."),
            user(f"SUPERSEDED CANDIDATES, epoch {epoch}: {'; '.join(obsolete)}. Every value in this ledger is obsolete."),
            assistant(f"Marked all epoch {epoch} candidates obsolete."),
            user(f"FINAL AUTHORITATIVE CORRECTIONS, epoch {epoch}: {'; '.join(corrections)}. These values replace the superseded candidates exactly."),
            assistant(f"Applied every final authoritative correction for epoch {epoch}."),
            user(f"AUTHORITATIVE WORK CHECKPOINT, epoch {epoch}: {'; '.join(tasks)}. Each state, receipt, and next action is current and must remain associated with its work item."),
            assistant(f"Recorded the authoritative work checkpoint for epoch {epoch}."),
        ])

    core = [item for epoch in epoch_messages for item in epoch]
    history = _pad_epochs(epoch_messages, seed, target_tokens)
    questions: list[dict] = []
    for category in CATEGORIES:
        available = [q for q in candidates if q["category"] == category]
        for index in range(questions_per_category):
            position = min(len(available) - 1, int((index + 0.5) * len(available) / questions_per_category))
            questions.append({"id": f"{category}-{index + 1:02d}", **available[position]})
    absent_questions = [
        f"What is the exact authoritative value of parameter-{seed}-absent?",
        f"Where does route-source-{seed}-absent route directly?",
        f"What exact authoritative output value did probe-{seed}-absent return?",
        f"What is the final authoritative value of corrected-field-{seed}-absent?",
        f"What is the exact current checkpoint for work-item-{seed}-absent? Return STATE|receipt=VALUE|next=VALUE.",
    ]
    for index, question in enumerate(absent_questions):
        questions.append({"id": f"unknown-{index + 1}", "category": "unknown", "epoch": None, "question": question, "expected": None})
    rendered_questions = "\n".join(f"{q['id']}: {q['question']}" for q in questions)
    question_text = (
        "Answer every question from the supplied project history or checkpoint. "
        "Return only a JSON object whose keys are exactly the question IDs below. "
        "Each answer must be the exact canonical string, with no explanation, labels, units, or extra punctuation. "
        "Return JSON null when the record does not establish the answer. Do not guess.\n\n"
        + rendered_questions
    )
    serialized_history = _json(history)
    assert all(value in serialized_history for value in all_payloads)
    assert all(q["expected"] in serialized_history for q in questions if q["expected"] is not None)
    assert all(value not in question_text for value in all_payloads)
    assert len(all_payloads) == 6 * density and len(set(all_payloads)) == len(all_payloads)
    assert count_tokens(history) == target_tokens
    fixture = {
        "id": fixture_id, "thread": history, "quiz": question_text,
        "questions": questions,
        "tools": [{"type": "function", "name": "database_query", "description": "Read an authoritative project probe without modifying state", "parameters": {"type": "object", "properties": {"project": {"type": "integer"}, "probe": {"type": "string"}}, "required": ["project", "probe"], "additionalProperties": False}}],
        "metadata": {
            "seed": seed, "density_per_category": density, "epoch_count": epochs,
            "target_tokens": target_tokens, "local_input_tokens": count_tokens(history),
            "local_core_tokens": count_tokens(core), "tokenizer": "o200k_base",
            "token_count_scope": "JSON serialization of input items with compact separators and sorted keys; not server billing usage",
            "authoritative_records": len(candidates), "authoritative_atomic_fields": 7 * density,
            "independent_random_payload_count": len(all_payloads),
            "known_question_count": questions_per_category * len(CATEGORIES), "unknown_question_count": len(absent_questions),
            "reference_commit": REFERENCE_COMMIT,
            "thread_sha256": hashlib.sha256(serialized_history.encode()).hexdigest(),
            "quiz_sha256": hashlib.sha256(question_text.encode()).hexdigest(),
            "questions_sha256": hashlib.sha256(_json(questions).encode()).hexdigest(),
        },
    }
    if retained_tokens is not None:
        fixture["retained"], fixture["metadata"]["retention"] = retained_user_messages(history, retained_tokens)
        fixture["metadata"]["retained_sha256"] = hashlib.sha256(_json(fixture["retained"]).encode()).hexdigest()
    return fixture


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--density", type=int, required=True)
    parser.add_argument("--tokens", "--target-tokens", dest="target_tokens", type=int, default=220_000)
    parser.add_argument("--questions-per-category", type=int, default=30)
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--retained-tokens", type=int)
    parser.add_argument("--out", "--output", dest="output", type=Path)
    args = parser.parse_args()
    fixture = build_fixture(args.seed, args.density, args.target_tokens, args.questions_per_category,
                            args.epochs, args.retained_tokens)
    encoded = json.dumps(fixture, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded)
        print(json.dumps({"id": fixture["id"], "metadata": fixture["metadata"]}, indent=2))
    else:
        print(encoded, end="")
