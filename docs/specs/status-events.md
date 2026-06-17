# Status and Event Spec

## 1. Job Status

MVP statuses:

```text
PENDING
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
git-runner.workers.ready.<routing-tag>
```

MVP stores latest status and terminal result in the local job store:

```text
.git-runner/jobs/<job-id>/status.json
.git-runner/jobs/<job-id>/result-summary.json
```

NATS events are used to transport updates. MVP job delivery uses NATS core publish/subscribe, so it is not durable. By default, submit sends a readiness request to `git-runner.workers.ready.<routing-tag>` before publishing a job. Workers subscribed for that tag respond with their current worker state. If readiness is bypassed, a worker must already be subscribed to `git-runner.jobs.<routing-tag>` when submit publishes the job. Persistent NATS JetStream KV or streams are future enhancements, not part of MVP.

## 5. Status Transitions

Allowed transitions:

```text
PENDING -> RUNNING
PENDING -> FAILED
PENDING -> CANCELLED
RUNNING -> COMPLETED
RUNNING -> FAILED
RUNNING -> CANCELLED
```

Worker subscribes to `git-runner.cancels.<job-id>` after accepting a job. A cancellation message moves a pending or running job to `CANCELLED` with reason `cancelled`. If the executor is running, supervisor terminates it before publishing terminal status.

Submitter writes `PENDING` to local job store when job is created. Worker publishes `RUNNING` after accepting and validating the job.

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
