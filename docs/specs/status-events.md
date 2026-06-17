# Status and Event Spec

## 1. Job Status

MVP statuses:

```text
PENDING
ACCEPTED
RUNNING
COMPLETED
FAILED
CANCELLED
```

Terminal statuses:

- `COMPLETED`
- `FAILED`
- `CANCELLED`

## 2. Reasons

MVP reasons:

```text
command_failed
timeout
result_missing
result_invalid
git_checkout_failed
worker_policy_denied
job_invalid
cancelled
```

Use `status + reason` instead of adding many terminal statuses.

The authoritative reason mapping is defined in [error-catalog.md](error-catalog.md).

`worker_auth_failed` is reserved for a future authenticated worker protocol and is not emitted by MVP.

## 3. Events

Status event:

```json
{
  "schema_version": 1,
  "event_type": "status",
  "job_id": "job_001",
  "status": "RUNNING",
  "reason": null,
  "worker_id": "local-001",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "source": {
    "repo": "git@github.com:user/project.git",
    "branch": "codex/exp-001",
    "commit": "8f3a21c"
  }
}
```

Log event:

```json
{
  "schema_version": 1,
  "event_type": "log",
  "job_id": "job_001",
  "stream": "stdout",
  "data": "base64-or-text-chunk",
  "encoding": "utf-8",
  "offset": 0,
  "timestamp": "2026-06-17T00:00:00.000Z"
}
```

Result event:

```json
{
  "schema_version": 1,
  "event_type": "result",
  "job_id": "job_001",
  "status": "COMPLETED",
  "reason": null,
  "worker_id": "local-001",
  "exit_code": 0,
  "signal": null,
  "duration_ms": 12345,
  "stdout_bytes": 1000,
  "stderr_bytes": 100,
  "result": {},
  "artifacts": [],
  "timestamp": "2026-06-17T00:00:00.000Z"
}
```

## 4. NATS Subjects

MVP subjects:

```text
git-runner.jobs.<routing-tag>
git-runner.cancels.<job-id>
git-runner.status.<job-id>
git-runner.logs.<job-id>
git-runner.results.<job-id>
git-runner.workers.<worker-id>.heartbeat
```

MVP stores latest status and terminal result in the local job store:

```text
.git-runner/jobs/<job-id>/status.json
.git-runner/jobs/<job-id>/result-summary.json
```

NATS events are used to transport updates.

Job delivery modes:

- Default core mode: submit uses NATS core request/reply on `git-runner.jobs.<routing-tag>` and requires a worker to accept the job message before returning.
- Core publish-only mode: if the guard is bypassed with `--no-require-worker`, submit publishes to the core subject and a worker must already be subscribed when submit publishes the job.
- JetStream mode: `--jetstream` publishes to stream `GIT_RUNNER_JOBS`, which stores subjects `git-runner.jobs.*`. Workers bind durable consumers filtered by tag, so a worker can start after submit and still receive matching jobs.

JetStream delivery is at-least-once. The worker acknowledges a JetStream job message after writing the terminal result summary and terminal status. If the worker crashes before acknowledgement, NATS can redeliver the message.

Workers use a local job store execution lock to make duplicate delivery safer:

- The worker that atomically creates `.git-runner/jobs/<job-id>/execution.lock` may execute the command.
- If another worker already holds the lock, the duplicate delivery does not execute the command.
- If `result-summary.json` already contains a terminal status, duplicate delivery is skipped and the existing result is preserved.
- In JetStream mode, terminal-result skips are acknowledged; lock-conflict skips are not acknowledged so JetStream can redeliver if the original worker never reaches a terminal result.

## 5. Status Transitions

Allowed transitions:

```text
PENDING -> ACCEPTED
ACCEPTED -> RUNNING
ACCEPTED -> FAILED
PENDING -> FAILED
RUNNING -> COMPLETED
RUNNING -> FAILED
RUNNING -> CANCELLED
```

Worker subscribes to `git-runner.cancels.<job-id>` after the job reaches `RUNNING`. A cancellation message moves a running job to `CANCELLED` with reason `cancelled`. If the executor is running, supervisor terminates it before publishing terminal status.

Submitter writes `PENDING` to local job store when job is created. In default core mode, worker writes and publishes `ACCEPTED` after acquiring the execution lock and before responding to request/reply dispatch. In JetStream mode, worker writes and publishes `ACCEPTED` after pulling the message from its durable consumer and acquiring the execution lock. If a worker crashes after acceptance but before validation or execution, the latest status can remain `ACCEPTED`; this means the job was delivered to a worker but no terminal outcome was recorded. Worker publishes `RUNNING` after validating schema and policy.

Inspection commands may compute stale diagnostics for `ACCEPTED` and for an existing `execution.lock` without changing the stored status. MVP stale detection is read-only: it does not release locks and does not retry jobs.

## 6. Heartbeat

Worker heartbeat:

```json
{
  "schema_version": 1,
  "worker_id": "local-001",
  "status": "idle",
  "tags": ["default"],
  "allow_all_repos": false,
  "current_job_id": null,
  "timestamp": "2026-06-17T00:00:00.000Z"
}
```

`status` values:

- `idle`
- `running`
- `stopping`

Heartbeat interval is 10 seconds.
