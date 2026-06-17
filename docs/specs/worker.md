# Worker Spec

## 1. Overview

Worker receives jobs from NATS, validates policy, prepares a Git workspace, checks out the specified commit, launches an executor process, and publishes status/log/result information.

MVP supports one running job per worker process.

## 2. Worker Config

Example:

```json
{
  "schema_version": 1,
  "worker_id": "local-001",
  "worker_key": "${GIT_RUNNER_WORKER_KEY}",
  "tags": ["default"],
  "allowed_tags": ["default", "gpu-large"],
  "allowed_repos": [
    "git@github.com:user/project.git"
  ],
  "workspace_root": ".git-runner/workspaces",
  "repo_cache_root": ".git-runner/repo-cache",
  "job_store_root": ".git-runner/jobs",
  "cleanup": {
    "mode": "after_job"
  }
}
```

CLI options override config fields. Environment variables fill documented secret fields.

## 3. Startup

Worker startup sequence:

1. Load config.
2. Resolve `worker_id`.
3. Resolve `worker_key`.
4. Resolve tags.
5. Connect to NATS.
6. Publish worker heartbeat.
7. Subscribe to job subjects for tags.

Subject subscription for tags:

```text
git-runner.jobs.<tag>
```

## 4. Job Handling

For each job:

1. Parse Job Spec.
2. Validate schema.
3. Validate worker policy.
4. Publish `RUNNING` status only after job is accepted.
5. Prepare workspace.
6. Fetch repository.
7. Checkout `source.commit` using detached HEAD.
8. Spawn executor process.
9. Monitor timeout and process exit.
10. Collect executor result.
11. Validate output result if schema is configured.
12. Collect artifacts.
13. Publish terminal status.
14. Cleanup workspace according to config.
15. Return to idle state.

## 5. Git Workspace

Worker uses two roots:

- `repo_cache_root`: reserved for a future reusable clone/fetch cache.
- `workspace_root`: per-job working tree.

MVP clones directly into a per-job workspace. `repo_cache_root` is reserved for a future cache optimization and is not required for the first implementation. The observable behavior must be:

```bash
git fetch origin
git checkout --detach <commit-sha>
```

Worker must not execute branch checkout as the execution authority.

Per-job workspace path must include `job_id` to avoid collisions.

## 6. Executor Process

Executor process receives an executor request from supervisor. The request must include:

```json
{
  "job_id": "job_001",
  "workspace_path": "/path/to/workspace",
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
  }
}
```

Executor responsibilities:

1. Create `.git-runner/` output directory if needed.
2. Write params file.
3. Run setup commands in order.
4. Run entry command.
5. Write stdout to `.git-runner/stdout.log`.
6. Write stderr to `.git-runner/stderr.log`.
7. Record exit code, signal, and duration.
8. Read result file if present.
9. Return an executor summary to supervisor.

Supervisor responsibilities:

1. Start executor process.
2. Enforce timeout.
3. Kill executor on timeout.
4. Capture process-level failure.
5. Convert executor outcome to job status.

## 7. Timeout

If executor runtime exceeds `execution.timeout_sec`:

- Supervisor kills the executor process.
- Job terminal status is `FAILED`.
- Job reason is `timeout`.
- Result summary includes `signal`; when the OS does not provide one, `signal` is `null` and timeout metadata is recorded in `reason`.

## 8. Exit Handling

Command exit code `0` means command success. Non-zero exit code means command failure unless result validation produces a more specific reason.

Common terminal mapping:

| Condition | Status | Reason |
| --- | --- | --- |
| command exit code 0 and result valid | `COMPLETED` | null |
| command exit code non-zero | `FAILED` | `command_failed` |
| executor timeout | `FAILED` | `timeout` |
| result missing when schema required | `FAILED` | `result_missing` |
| result invalid | `FAILED` | `result_invalid` |
| git checkout failed | `FAILED` | `git_checkout_failed` |
| job validation failed | `FAILED` | `job_invalid` |
| policy denied | `FAILED` | `worker_policy_denied` |
| job cancelled | `CANCELLED` | `cancelled` |

The complete error mapping is defined in [error-catalog.md](error-catalog.md).

## 9. Cleanup

MVP cleanup modes:

- `after_job`: remove per-job workspace after terminal status and artifact collection.
- `never`: keep workspace for debugging.

Default is `after_job`.
