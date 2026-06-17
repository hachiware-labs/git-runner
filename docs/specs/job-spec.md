# Job Spec

## 1. Overview

Job Spec is the JSON contract published by `git-runner submit` and consumed by `git-runner worker`.

MVP schema version is `1`.

## 2. Minimal Job Spec

```json
{
  "schema_version": 1,
  "job_id": "job_001",
  "source": {
    "type": "git",
    "repo": "git@github.com:user/project.git",
    "branch": "codex/exp-001",
    "commit": "8f3a21c"
  },
  "working_dir": ".",
  "setup": [],
  "entry": {
    "type": "command",
    "command": "npm test"
  },
  "params": {},
  "param_passing": {
    "mode": "json_file",
    "path": ".git-runner/params.json"
  },
  "outputs": {
    "result": {
      "path": ".git-runner/result.json",
      "schema": {
        "type": "none"
      }
    },
    "artifacts": []
  },
  "execution": {
    "timeout_sec": 3600,
    "max_stdout_bytes": 10485760,
    "max_stderr_bytes": 10485760
  },
  "worker": {
    "tags": ["default"]
  },
  "runtime": {
    "type": "host"
  }
}
```

## 3. Fields

### 3.1 `schema_version`

Required integer. MVP value is `1`.

### 3.2 `job_id`

Required string. Must be unique enough for the configured deployment.

Recommended format:

```text
job_<lowercase-base32-or-hex>
```

### 3.3 `source`

Required object.

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | MVP value is `git` |
| `repo` | yes | clone/fetch URL or local path usable by worker |
| `branch` | no | provenance branch |
| `commit` | yes | execution commit SHA |

`source.commit` is the execution authority. Worker must not execute by resolving `source.branch`.

If submit received both branch and commit, `source.commit` is the selected execution commit and `source.branch` is provenance only.

### 3.4 `working_dir`

Required string. Path relative to repository root. Default is `"."`.

Worker must reject paths that escape repository root after normalization.

### 3.5 `setup`

Required array. Default is `[]`.

Each setup entry for MVP:

```json
{
  "type": "command",
  "command": "npm ci"
}
```

MVP supports setup entries with `type: "command"`. Setup commands run before `entry.command` in order. If any setup command exits non-zero, the job fails with `command_failed` and the entry command is not executed.

### 3.6 `entry`

Required object.

MVP supports only:

```json
{
  "type": "command",
  "command": "npm test"
}
```

The executor runs commands through Node.js `child_process.spawn(command, { shell: true, cwd })`. On Windows this uses the Node.js default shell for the platform, normally `cmd.exe` via `ComSpec`; on POSIX systems this uses `/bin/sh`.

### 3.7 `params`

Required object. Default is `{}`.

Must be JSON-serializable.

### 3.8 `param_passing`

Required object.

MVP supports:

```json
{
  "mode": "json_file",
  "path": ".git-runner/params.json"
}
```

Worker writes:

```json
{
  "job_id": "job_001",
  "params": {}
}
```

The path is relative to repository root unless otherwise specified. Worker must reject paths that escape repository root.

### 3.9 `outputs`

Required object.

See [result-artifacts.md](result-artifacts.md).

### 3.10 `execution`

Required object.

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `timeout_sec` | yes | `3600` | max executor runtime |
| `max_stdout_bytes` | yes | `10485760` | stdout capture limit |
| `max_stderr_bytes` | yes | `10485760` | stderr capture limit |

### 3.11 `worker`

Required object.

```json
{
  "tags": ["default"]
}
```

MVP routing uses `worker.tags[0]`.

### 3.12 `runtime`

Required object.

MVP supports:

```json
{
  "type": "host"
}
```

## 4. Validation Rules

Worker must reject a job as `FAILED` with `job_invalid` before execution if:

- `schema_version` is unsupported.
- `job_id` is missing or empty.
- `source.type` is not `git`.
- `source.repo` is missing.
- `source.commit` is missing.
- setup entry type is unsupported.
- setup command is empty.
- `entry.type` is not `command`.
- `entry.command` is empty.
- `params` is not a JSON object.
- `param_passing.mode` is not `json_file`.
- `working_dir` escapes repository root.
- `param_passing.path` escapes repository root.
- output paths escape repository root.
- output schema type is unsupported.
- `execution.timeout_sec` is not positive.
- stdout/stderr limits are not positive.
- runtime type is not `host`.

Worker must reject a job as `FAILED` with `worker_policy_denied` before execution if:

- worker tags do not match policy.
- repository is not allowed by policy.
- job-controlled absolute paths are provided.

The authoritative validation and policy mapping is defined in [error-catalog.md](error-catalog.md).

## 5. Local Run Compatibility

`git-runner local run` consumes Job Spec schema version `1`, but accepts a small compatibility surface for Research Booster local-runner fixtures:

- `setup` may contain strings, which are normalized to `{ "type": "command", "command": <string> }`.
- `worker.routing_tag` may be used instead of `worker.tags[0]`.
- missing `runtime` is treated as `{ "type": "host" }`.

Distributed workers should continue to receive canonical Job Specs with command setup objects, `worker.tags`, and explicit host runtime. The local compatibility rules are defined in [local-run.md](local-run.md).
