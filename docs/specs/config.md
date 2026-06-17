# Config Spec

## 1. Project Config

Default path:

```text
.git-runner/config.json
```

Created by:

```bash
git-runner init
```

Schema:

```json
{
  "schema_version": 1,
  "nats_url": "nats://localhost:4222",
  "default_worker_tags": ["default"],
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
  "job_store_root": ".git-runner/jobs"
}
```

Rules:

- `schema_version` is required and must be `1`.
- CLI options override config values.
- Environment variables override config values only for fields explicitly documented by the CLI spec.
- `git-runner init` must not overwrite an existing config unless a future `--force` option is added.

## 2. Worker Config

Default path:

```text
.git-runner/worker.json
```

Schema:

```json
{
  "schema_version": 1,
  "worker_id": "local-001",
  "tags": ["default"],
  "allowed_tags": ["default"],
  "allowed_repos": [],
  "allow_all_repos": false,
  "workspace_root": ".git-runner/workspaces",
  "repo_cache_root": ".git-runner/repo-cache",
  "job_store_root": ".git-runner/jobs",
  "delivery_mode": "core",
  "cleanup": {
    "mode": "after_job"
  }
}
```

`worker_key` must be supplied by CLI option or `GIT_RUNNER_WORKER_KEY`. `git-runner init` must not persist it to config.

Rules:

- `worker_id` is required.
- `tags` defaults to `["default"]`.
- `allowed_tags` defaults to `tags`.
- `allowed_repos` defaults to `[]`.
- `allow_all_repos` defaults to `false`.
- If `allow_all_repos` is `false` and `allowed_repos` is empty, the worker starts but denies all repository jobs.
- `delivery_mode` defaults to `core` and must be `core` or `jetstream`.
- `cleanup.mode` defaults to `after_job`.

## 3. Environment Variables

| Env | Used By | Description |
| --- | --- | --- |
| `GIT_RUNNER_NATS_URL` | submit, worker, status, logs, get | NATS server URL |
| `GIT_RUNNER_WORKER_KEY` | worker | Worker key |

CLI options take precedence over environment variables.

## 4. Path Resolution

Config paths are resolved relative to the current working directory unless an absolute path is provided.

Job-controlled paths are resolved relative to repository root and must not escape repository root.
