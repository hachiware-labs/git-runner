# Result Bundle Spec

## 1. Goal

Result Bundle is a portable terminal snapshot of a git-runner job. It lets Research Booster, Codex, or another caller import one completed job without needing direct access to worker internals.

The local job store remains the execution-time source of truth. A Result Bundle is produced only for terminal jobs or by `git-runner local run` after local execution reaches a terminal status.

The machine-readable JSON Schema is maintained at [../../src/schemas/git-runner.result-bundle.v1.schema.json](../../src/schemas/git-runner.result-bundle.v1.schema.json). Producers should validate bundles before writing them.

## 2. When To Produce

Result Bundle producers:

- `git-runner local run <job.json> --bundle <path>`
- `git-runner get <job-id> --bundle [path]`

Required conditions:

- job status is `COMPLETED`, `FAILED`, or `CANCELLED`;
- original job spec is included;
- source metadata is included;
- worker metadata is included;
- stdout/stderr metadata is included;
- result output config is preserved;
- parsed result JSON is included under `outputs.result.value` when available;
- artifact metadata is included.

Non-terminal jobs must not be emitted as Result Bundles.

## 3. Bundle Shape

```json
{
  "schema_version": "git-runner.result-bundle.v1",
  "job_id": "job_001",
  "status": "COMPLETED",
  "reason": null,
  "job": {},
  "source": {
    "type": "git",
    "repo": "git@github.com:user/project.git",
    "branch": "codex/exp-001",
    "commit": "8f3a21c"
  },
  "worker": {
    "worker_id": "local-001",
    "routing_tag": "default"
  },
  "timing": {
    "submitted_at": "2026-06-18T00:00:00Z",
    "started_at": "2026-06-18T00:00:00Z",
    "finished_at": "2026-06-18T00:00:01Z",
    "duration_ms": 1000
  },
  "execution": {
    "exit_code": 0,
    "signal": null,
    "timed_out": false,
    "commands": []
  },
  "outputs": {
    "stdout": {
      "file": ".git-runner/stdout.txt",
      "bytes": 0
    },
    "stderr": {
      "file": ".git-runner/stderr.txt",
      "bytes": 0
    },
    "result": {
      "path": ".research-run/result.json",
      "schema": {
        "type": "json_schema",
        "file": "schemas/research-booster.v1.schema.json"
      },
      "file": ".research-run/result.json",
      "value": {}
    },
    "artifacts": []
  },
  "error": null
}
```

## 4. Required Fields

| Field | Required | Description |
| --- | --- | --- |
| `schema_version` | yes | Must be `git-runner.result-bundle.v1`. |
| `job_id` | yes | Original job id. |
| `status` | yes | Terminal status: `COMPLETED`, `FAILED`, or `CANCELLED`. |
| `reason` | yes | Failure/cancel reason, or `null`. |
| `job` | yes | Original job spec as consumed by the runner. |
| `source` | yes | `job.source` metadata. |
| `worker` | yes | Worker metadata with `worker_id` and `routing_tag`. |
| `timing` | yes | Submitted/started/finished timestamps where known, plus duration. |
| `execution` | yes | Exit code, signal, timeout flag, and optional command run metadata. |
| `outputs` | yes | stdout/stderr/result/artifact metadata. |
| `error` | yes | Structured failure details, or `null`. |

## 5. Result Rules

- `outputs.result.path` preserves the job output path.
- `outputs.result.schema` preserves the job output schema config.
- `outputs.result.value` is preferred for portable Research Booster import.
- `outputs.result.file` may point to a workspace-relative or bundle-adjacent file.
- If schema type is `json_schema`, the producer must validate result JSON before emitting `COMPLETED`.
- If required result JSON is missing, status is `FAILED` with reason `result_missing`.
- If result JSON or schema validation fails, status is `FAILED` with reason `result_invalid`.
- A failed command may still include a parsed `outputs.result.value` when the command produced useful evidence.

### 5.1 Size Rules

Bundles are intended to be small enough for CLI output and Web UI inspection. Producers must not embed stdout, stderr, or artifact file contents.

`outputs.result.value` may be embedded only while it stays within the producer's inline result budget. The default git-runner budget is 256 KiB of UTF-8 JSON. If the result is larger, producers set `outputs.result.value` to `null` and add a `result_omitted_from_bundle` warning with the original byte count and limit.

## 6. Artifact Rules

Artifact entries preserve job artifact config and add availability metadata.

```json
{
  "name": "evaluation_report",
  "path": "results/report.md",
  "kind": "report",
  "required": false,
  "file": "results/report.md",
  "bytes": 1234
}
```

Rules:

- Missing optional artifacts are reported but do not fail the bundle.
- Missing required artifacts fail the bundle with reason `artifact_missing`.
- Local producers should use `file` for accessible filesystem paths.
- Distributed producers may use future object references.

## 7. Research Booster Import Compatibility

Research Booster imports these fields:

```text
bundle.job_id
  -> run.git_runner.job_id

bundle.status / reason
  -> run.git_runner.status / reason

bundle.source
  -> run.git_runner.repo / commit / branch

bundle.worker
  -> run.git_runner.worker_id / routing_tag

bundle.job.params
  -> run.params

bundle.outputs.result.value
  -> run.result
```

Research Booster must reject non-terminal bundles and bundles without valid result JSON when import requires a result.
