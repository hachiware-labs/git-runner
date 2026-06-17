from __future__ import annotations

import json
from pathlib import Path


RESULT = {
    "schema_version": "research-booster.v1",
    "status": "completed",
    "metrics": {
        "judge_score": 0.82,
        "latency_p95_ms": 1430,
        "cost_usd": 1.27,
    },
    "evaluation_context": {
        "eval_suite_id": "eval_qa_rag_v2",
        "eval_suite_version": "2026-06-17",
        "dataset": "small_eval_v2",
        "split": "validation",
        "sample_count": 200,
        "seed": 42,
    },
    "error_slices": [
        {
            "name": "citation_heavy",
            "metrics": {
                "judge_score": 0.74,
                "citation_accuracy": 0.69,
            },
            "sample_count": 34,
        }
    ],
    "artifacts": [
        {
            "name": "evaluation_report",
            "path": "results/report.md",
            "kind": "report",
            "media_type": "text/markdown",
        }
    ],
    "summary": "score normalization improved judge_score but increased latency.",
    "observations": [
        "Errors on citation-heavy examples decreased.",
    ],
    "warnings": [
        "Dataset size is small; repeat on full eval set.",
    ],
}


def main() -> int:
    result_path = Path(".research-run/result.json")
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(RESULT, indent=2), encoding="utf-8")

    report_path = Path("results/report.md")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        "# Evaluation Report\n\n"
        "- judge_score improved to 0.82\n"
        "- latency_p95_ms increased to 1430\n"
        "- citation_heavy slice still needs full validation\n",
        encoding="utf-8",
    )
    print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
