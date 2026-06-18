# Result and Artifacts Spec

## 1. Files

Worker stores at least:

```text
.git-runner/stdout.log
.git-runner/stderr.log
.git-runner/result.json
```

The result file may be absent when output schema type is `none`.

## 2. Output Config

```json
{
  "outputs": {
    "result": {
      "path": ".git-runner/result.json",
      "schema": {
        "type": "none"
      }
    },
    "artifacts": []
  }
}
```

## 3. Result Schema Types

### 3.1 `none`

```json
{
  "type": "none"
}
```

Rules:

- result file is optional.
- If result file exists and is valid JSON, store parsed JSON as raw result.
- If result file exists but is invalid JSON, do not fail an otherwise successful command. Store `null` as `result` and add a `result_warnings` entry with code `optional_result_invalid_json`.
- job status is primarily determined by command exit status.

### 3.2 `json_schema`

```json
{
  "type": "json_schema",
  "file": "schemas/research-result.schema.json"
}
```

Rules:

- result file is required.
- result file must parse as JSON.
- schema file path is relative to repository root.
- JSON Schema draft-07 and draft 2020-12 are supported.
- JSON Schema validation must pass.
- If command succeeds but result validation fails, job status is `FAILED` with reason `result_invalid` or `result_missing`.

## 4. Result Summary

Terminal result shape:

```json
{
  "job_id": "job_001",
  "status": "COMPLETED",
  "reason": null,
  "worker_id": "local-001",
  "source": {
    "repo": "git@github.com:user/project.git",
    "branch": "codex/exp-001",
    "commit": "8f3a21c"
  },
  "exit_code": 0,
  "signal": null,
  "duration_ms": 12345,
  "stdout_bytes": 1000,
  "stderr_bytes": 100,
  "result": {},
  "result_warnings": [],
  "artifacts": []
}
```

Result Summary is the local job store terminal metadata. Portable terminal snapshots for Research Booster/Codex import use [result-bundle.md](result-bundle.md).

## 5. Artifacts

Artifact config:

```json
{
  "name": "report",
  "path": "results/report.md",
  "kind": "report",
  "media_type": "text/markdown"
}
```

Fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | logical artifact name |
| `path` | yes | path relative to repository root |
| `kind` | no | user-defined artifact kind |
| `media_type` | no | MIME type |

MVP rules:

- Artifact paths must not escape repository root.
- Missing artifacts are recorded in result metadata.
- Missing artifacts do not fail the job unless future specs add `required: true`.
- MVP storage is local filesystem under `job_store_root`.

Collected artifact metadata:

```json
{
  "name": "report",
  "path": "results/report.md",
  "kind": "report",
  "media_type": "text/markdown",
  "size_bytes": 1234,
  "sha256": "..."
}
```

## 6. Logs

stdout/stderr capture limits are defined by Job Spec execution fields.

If stdout or stderr exceeds the limit:

- Capture up to the configured limit.
- Record truncation metadata.
- Do not fail the job solely because logs were truncated.

Log metadata:

```json
{
  "stdout_bytes": 10485760,
  "stdout_truncated": true,
  "stderr_bytes": 100,
  "stderr_truncated": false
}
```

## 7. Local Job Store

MVP stores job data under:

```text
.git-runner/jobs/<job-id>/
  job-spec.json
  status.json
  stdout.log
  stderr.log
  result-summary.json
  artifacts/
```

`git-runner status`, `git-runner logs`, and `git-runner get` read from this store.
