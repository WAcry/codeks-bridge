#!/usr/bin/env python3
"""Plot recovery quality against replay size from public results.json."""

import argparse
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import FuncFormatter, MaxNLocator, PercentFormatter


ARMS = {
    "K1": ("K1 Built-in", "#D55E00", "o"),
    "K2": ("K2 Claude Code-style", "#0072B2", "s"),
    "K3": ("K3 Native", "#009E73", "^"),
    "K4": ("K4 Handoff", "#CC79A7", "D"),
}


def load_cases(path, excluded=()):
    data = json.loads(path.read_text(encoding="utf-8"))
    if data["schema_version"] != 1:
        raise ValueError("Expected results schema version 1")
    case_ids = {case["id"] for case in data["cases"]}
    if unknown := set(excluded) - case_ids:
        raise ValueError(f"Unknown excluded cases: {sorted(unknown)}")
    cohorts = {"stress": [], "normal": []}
    for case in data["cases"]:
        if case["id"] in excluded:
            continue
        cohort = case["id"].split("-", 1)[0]
        if cohort not in cohorts:
            raise ValueError(f"Unknown cohort: {cohort}")
        quizzes = {quiz["request"]: quiz for quiz in case["quizzes"]}
        points = {}
        for arm in ARMS:
            quiz = quizzes[f"quiz-{arm}"]
            tokens = quiz["replay_input_tokens"]
            accuracy = quiz["score"]["known"]["accuracy"]
            if not isinstance(tokens, (int, float)) or not math.isfinite(tokens) or tokens < 0:
                raise ValueError(f"Invalid replay input tokens for {case['id']} {arm}")
            if not isinstance(accuracy, (int, float)) or not math.isfinite(accuracy) or not 0 <= accuracy <= 1:
                raise ValueError(f"Invalid known accuracy for {case['id']} {arm}")
            points[arm] = (tokens, accuracy)
        cohorts[cohort].append((case["id"], points))
    for cohort, cases in cohorts.items():
        if not cases:
            raise ValueError(f"No cases for {cohort}")
        cases.sort(key=lambda case: case[0])
    return cohorts


def plot(cohorts, output, excluded=()):
    # Fixed font, SVG IDs, and metadata make repeated exports deterministic.
    plt.rcdefaults()
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 10,
        "svg.hashsalt": "compaction",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.edgecolor": "#777777",
        "axes.labelcolor": "#333333",
        "xtick.color": "#444444",
        "ytick.color": "#444444",
        "savefig.facecolor": "white",
    })
    fig, axes = plt.subplots(1, 2, figsize=(10.8, 5.1), sharey=True)
    fig.subplots_adjust(left=0.08, right=0.98, bottom=0.28, top=0.79, wspace=0.16)
    fig.suptitle("Compaction quality vs. replay size", fontsize=15, y=0.96)
    if excluded:
        fig.text(0.5, 0.89, "Post hoc exclusion, all arms: " + ", ".join(excluded),
                 ha="center", fontsize=9, color="#555555")

    for ax, (cohort, cases) in zip(axes, cohorts.items()):
        for _, points in cases:
            ax.annotate(
                "", xy=points["K4"], xytext=points["K3"],
                arrowprops={"arrowstyle": "->", "color": "#777777", "lw": 0.8,
                            "alpha": 0.55, "shrinkA": 5, "shrinkB": 5},
                zorder=1,
            )
        for arm, (_, color, marker) in ARMS.items():
            points = [case[1][arm] for case in cases]
            ax.scatter(
                [point[0] for point in points], [point[1] for point in points],
                color=color, marker=marker, s=58, alpha=0.88,
                edgecolors="white", linewidths=0.65, zorder=2,
            )
        title = (f"Stress: {len(cases)} {'retained' if excluded else 'independent'} seeds" if cohort == "stress"
                 else f"Normal: {len(cases)} repeats of one history")
        ax.set_title(title, fontsize=11, pad=12)
        ax.set_xlabel("Replay input tokens", labelpad=8)
        ax.set_xlim(left=0)
        ax.set_ylim(-0.025, 1.055)
        ax.set_yticks([0, 0.2, 0.4, 0.6, 0.8, 1])
        ax.yaxis.set_major_formatter(PercentFormatter(xmax=1, decimals=0))
        ax.xaxis.set_major_locator(MaxNLocator(nbins=5, integer=True))
        ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:,.0f}"))
        ax.set_axisbelow(True)
        ax.grid(axis="y", color="#E5E5E5", linewidth=0.7)
    axes[0].set_ylabel("Known-fact accuracy", labelpad=8)

    handles = [Line2D([], [], linestyle="", marker=marker, color=color,
                      markersize=7, label=label)
               for label, color, marker in ARMS.values()]
    fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.12),
               ncol=4, frameon=False, columnspacing=1.6, handletextpad=0.5)
    fig.text(0.5, 0.065, "Each point is one product from one run. Arrows pair native → handoff within a run.",
             ha="center", fontsize=9, color="#555555")
    fig.text(0.5, 0.025, "Panels use separate token scales. Handoff generation also receives retained user messages.",
             ha="center", fontsize=9, color="#555555")

    metadata = ({"Date": None, "Creator": None} if output.suffix.lower() == ".svg"
                else {"Software": None})
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=300, metadata=metadata)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path, help="Public results.json")
    parser.add_argument("output", type=Path, help="Output figure (.svg or .png)")
    parser.add_argument("--exclude-case", action="append", default=[],
                        help="Omit a whole case from every arm; repeat for multiple cases")
    args = parser.parse_args()
    if args.output.suffix.lower() not in {".svg", ".png"}:
        parser.error("Output must have an .svg or .png extension")
    plot(load_cases(args.results, args.exclude_case), args.output, args.exclude_case)


if __name__ == "__main__":
    main()
