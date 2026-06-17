# CLI Spec

## 1. Command

package は `git-runner` binary を提供する。

```bash
git-runner <command> [options]
```

MVP command:

- `init`
- `submit`
- `worker`
- `status`
- `logs`
- `get`

## 2. Common Options

| Option | Env | Default | Description |
| --- | --- | --- | --- |
| `--nats-url <url>` | `GIT_RUNNER_NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `--config <path>` | none | `.git-runner/config.json` | project config path |
| `--json` | none | `false` | machine-readable JSON output |

CLI option は environment variable より優先する。

Project and worker config fields are defined in [config.md](config.md). Git behavior is defined in [git.md](git.md).

CLI failure exit codes are defined in [error-catalog.md](error-catalog.md).

## 3. `git-runner init`

```bash
git-runner init [--config .git-runner/config.json]
```

Behavior:

1. `.git-runner/` を作成する。
2. config file が存在しない場合、初期 config を作成する。
3. 既存 config は上書きしない。

初期 config 例:

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

## 4. `git-runner submit`

```bash
git-runner submit \
  --repo . \
  --command "npm test" \
  [--branch codex/exp-001] \
  [--commit <sha>] \
  [--commit-and-push] \
  [--working-dir .] \
  [--params params.json] \
  [--message "git-runner submit"] \
  [--result-path .git-runner/result.json] \
  [--result-schema schemas/result.schema.json] \
  [--worker-tags default] \
  [--timeout-sec 3600] \
  [--jetstream] \
  [--no-require-worker] \
  [--dry-run]
```

### 4.1 Required Inputs

- `--command <command>` is required.
- `--repo <path-or-url>` defaults to `.`.

### 4.2 Git Behavior

Submit resolves the execution commit using this precedence:

1. If `--commit` is provided, use it as `source.commit`.
2. Else if `--branch` is provided, resolve branch HEAD at submit time and use that SHA as `source.commit`.
3. Else resolve current HEAD and use that SHA as `source.commit`.

If both `--commit` and `--branch` are provided, `--commit` wins.

`--commit-and-push` behavior:

- The CLI must not commit or push unless `--commit-and-push` is explicitly provided.
- If `--commit-and-push` is not provided and the working tree is dirty, submit still uses the resolved HEAD commit and emits a warning that uncommitted changes are not included in the job.
- If `--commit-and-push` is provided, the CLI creates or checks out `--branch` when specified; otherwise it uses the current branch.
- If `--commit-and-push` is provided, the CLI stages all repository changes with `git add -A`.
- If staged changes exist, the CLI commits them. The commit message is `--message` when provided, otherwise `git-runner submit <job_id>`.
- If no staged changes exist after `git add -A`, the CLI does not create an empty commit.
- The CLI pushes the selected branch to its upstream. If no upstream exists, it pushes to `origin <branch>` and sets upstream.
- After commit/push, the CLI resolves the final HEAD commit SHA and stores it in `source.commit`.

If `--commit-and-push` is provided while HEAD is detached and `--branch` is not provided, submit fails with a clear error.

### 4.3 Job Dispatch

If `--dry-run` is provided, submit resolves Git state and builds the Job Spec, then prints it without writing local job store files and without publishing to NATS.

If `--dry-run` is not provided, submit writes local pending job metadata and dispatches the Job Spec to `git-runner.jobs.<routing-tag>`.

Dispatch behavior:

- By default, submit uses NATS request/reply on the job subject and requires a matching worker to accept the job message before returning.
- If no worker accepts the job, submit fails with NATS exit code `4` and removes the local pending job metadata.
- `--no-require-worker` disables this guard and uses publish-only delivery.
- With the guard disabled, NATS core publish/subscribe does not retain the job for workers that subscribe later.
- `--jetstream` publishes the job to JetStream stream `GIT_RUNNER_JOBS`.
- In JetStream mode, a matching worker can start after submit and still receive the job.
- `--jetstream` requires the NATS server to have JetStream enabled. The CLI does not start or manage the NATS server.
- JetStream delivery is at-least-once. The worker acknowledges the message only after a terminal job result is written.
- `--jetstream` and `--no-require-worker` are mutually exclusive because `--no-require-worker` only applies to NATS core dispatch.

Submit builds a Job Spec and dispatches it to:

```text
git-runner.jobs.<routing-tag>
```

Routing tag:

- If `--worker-tags` is provided, use the first tag.
- Else use config `default_worker_tags[0]`.
- Else use `default`.

### 4.4 Output

Human output:

```text
job_id: job_...
commit: <sha>
subject: git-runner.jobs.default
```

JSON output:

```json
{
  "job_id": "job_...",
  "commit": "<sha>",
  "subject": "git-runner.jobs.default"
}
```

## 5. `git-runner worker`

```bash
git-runner worker \
  [--nats-url nats://localhost:4222] \
  --worker-id local-001 \
  --worker-key <key> \
  [--tags default,gpu-large] \
  [--allow-repo git@github.com:user/project.git] \
  [--allow-all-repos] \
  [--jetstream] \
  [--once] \
  [--job-store-root .git-runner/jobs] \
  [--config .git-runner/worker.json]
```

Required:

- `--worker-id` or config `worker_id`
- `--worker-key` or env `GIT_RUNNER_WORKER_KEY`

Behavior:

1. Load worker config.
2. Connect to NATS.
3. Validate worker key according to MVP policy.
4. Subscribe to job subjects for configured tags, or bind JetStream durable consumers when `--jetstream` or `delivery_mode: "jetstream"` is configured.
5. Validate job against worker policy.
6. Prepare workspace.
7. Start executor process.
8. Publish status/log/result events.
9. Return to idle state after terminal job status.

If `--once` is provided, worker exits after one accepted job reaches a terminal status. Without `--once`, worker stays subscribed.

Delivery modes:

- `core`: default. Worker subscribes to NATS core subjects `git-runner.jobs.<tag>`.
- `jetstream`: worker creates or binds durable consumers for `GIT_RUNNER_JOBS`, filtered by `git-runner.jobs.<tag>`.

Repository policy:

- `--allow-repo` can be provided multiple times.
- If no allowed repository is configured, worker denies all jobs unless `--allow-all-repos` is explicit.
- `--allow-all-repos` is intended for local development.

## 6. `git-runner status`

```bash
git-runner status <job-id> [--json] [--stale-after-sec 60]
```

Returns latest known status for the job.

If latest status is `ACCEPTED`, `status` computes diagnostic stale metadata from the status `timestamp`:

- `stale`: `true` when accepted age is greater than or equal to `--stale-after-sec`.
- `age_sec`: accepted status age in seconds.
- `stale_after_sec`: threshold used for the calculation.

If `.git-runner/jobs/<job-id>/execution.lock` exists, `status` also returns `execution_lock` diagnostics:

- `present`: `true`
- `worker_id`: worker that acquired the lock, when known
- `pid`: worker process id, when known
- `acquired_at`: lock acquisition timestamp, when known
- `age_sec`: lock age in seconds, when `acquired_at` is parseable
- `stale`: `true` when lock age is greater than or equal to `--stale-after-sec`
- `stale_after_sec`: threshold used for the calculation
- `error`: lock metadata read error, when owner metadata is missing or invalid

The default `--stale-after-sec` value is `60`. Stale detection does not mutate job status, release locks, or retry the job.

Human output:

```text
job_id: job_...
status: RUNNING
reason:
worker_id: local-001
commit: <sha>
started_at: 2026-06-17T00:00:00.000Z
```

Accepted stale output includes diagnostic fields:

```text
job_id: job_...
status: ACCEPTED
reason:
worker_id: local-001
commit: <sha>
stale: false
age_sec: 3
stale_after_sec: 60
execution_lock: present
execution_lock_worker_id: local-001
execution_lock_acquired_at: 2026-06-17T00:00:00.000Z
execution_lock_age_sec: 3
execution_lock_stale: false
execution_lock_stale_after_sec: 60
```

## 7. `git-runner logs`

```bash
git-runner logs <job-id> [--stream] [--stderr] [--stdout]
```

Default behavior returns stdout and stderr summaries if available.

MVP reads logs from the configured local job store:

```text
.git-runner/jobs/<job-id>/stdout.log
.git-runner/jobs/<job-id>/stderr.log
```

MVP assumes `logs` can access the same `job_store_root` used by worker. Multi-machine log retrieval without shared storage is out of scope for MVP.

## 8. `git-runner get`

```bash
git-runner get <job-id> [--json] [--output <dir>]
```

Returns result metadata and optionally downloads artifacts.

JSON output shape is defined in [result-artifacts.md](result-artifacts.md).
