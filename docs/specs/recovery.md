# Recovery Spec

## 1. Scope

This spec defines read-only diagnosis and manual recovery for jobs that may be stuck because a worker crashed while holding `.git-runner/jobs/<job-id>/execution.lock`.

MVP does not automatically release execution locks. Lock age alone is not enough proof that a worker is dead, because a long-running command can legitimately hold the lock longer than the default stale threshold.

## 2. Stale Lock Diagnosis

Use `status` to inspect both job status and execution lock state:

```bash
git-runner status <job-id> --json --stale-after-sec 300
```

Relevant fields:

```json
{
  "status": "ACCEPTED",
  "stale": true,
  "execution_lock": {
    "present": true,
    "worker_id": "local-001",
    "pid": 12345,
    "acquired_at": "2026-06-18T00:00:00.000Z",
    "age_sec": 900,
    "stale": true,
    "stale_after_sec": 300
  }
}
```

`execution_lock.stale: true` means the lock is older than the selected threshold. It does not prove the worker is dead and must not trigger automatic unlock by itself.

## 3. Recovery Preconditions

Manual lock recovery is allowed only when all of the following are true:

1. `git-runner status <job-id> --json` reports `execution_lock.present: true`.
2. `execution_lock.stale: true` for an operator-selected threshold that is longer than the expected normal job runtime.
3. No terminal `result-summary.json` exists for the job, or existing terminal result has already been preserved and no rerun is intended.
4. The operator has confirmed that the lock owner is not actively executing the job.
5. The operator accepts that removing the lock can allow the job to run again.

Ways to confirm the owner is inactive:

- On the same host, check that `execution_lock.pid` is no longer alive.
- On a worker host, check process manager logs for `execution_lock.worker_id`.
- In JetStream mode, check that no worker heartbeat for the owner indicates the same `current_job_id`.
- In shared filesystem deployments, confirm that only one worker fleet uses the target `job_store_root`.

## 4. Manual Recovery Procedure

### 4.1 Preserve Evidence

Before removing a lock, copy or rename the lock directory for audit:

```text
.git-runner/jobs/<job-id>/execution.lock
.git-runner/jobs/<job-id>/execution.lock.recovered-<timestamp>
```

The preserved `owner.json` records the worker id, process id, and acquisition time.

### 4.2 Remove the Lock

After the preconditions are satisfied, remove only:

```text
.git-runner/jobs/<job-id>/execution.lock
```

Do not remove `job-spec.json`, `status.json`, logs, artifacts, or `result-summary.json`.

### 4.3 Resume Delivery

Recovery depends on delivery mode:

- JetStream mode: start a matching `git-runner worker --jetstream`. If the message was not acknowledged, JetStream can redeliver it after `ack_wait` or after consumer state advances.
- Core request/reply mode: there is no durable queued message. Submit a new job if rerun is required.
- Core publish-only mode: there is no durable queued message. Submit a new job if rerun is required.

## 5. `recover-lock` Dry-Run Command

`recover-lock` inspects recovery preconditions without mutating job store files:

```bash
git-runner recover-lock <job-id> \
  [--stale-after-sec 300] \
  [--json]
```

Required behavior:

- The command is always dry-run in MVP.
- The command prints lock owner metadata, terminal result presence, `eligible`, `reason`, and `next_steps`.
- The command must not remove, rename, or edit `execution.lock`.
- The command reports `eligible: false` when no lock exists.
- The command reports `eligible: false` when a terminal `result-summary.json` exists.
- The command reports `eligible: false` when the lock is not stale for the selected threshold.
- The command reports `eligible: true` only when a lock exists, no terminal result exists, and the lock is stale for the selected threshold.

`eligible: true` is not permission to delete `execution.lock`. It means the dry-run found the minimum state needed to begin operator review. The operator must still confirm the worker is no longer executing the job, preserve lock metadata for audit, and decide whether manual recovery is appropriate.

Example eligible output:

```json
{
  "schema_version": 1,
  "command": "recover-lock",
  "dry_run": true,
  "job_id": "job_stale_lock",
  "eligible": true,
  "reason": "ready_for_manual_confirmation",
  "stale_after_sec": 300,
  "execution_lock": {
    "present": true,
    "worker_id": "local-001",
    "pid": 123,
    "acquired_at": "2026-06-18T00:00:00.000Z",
    "stale_after_sec": 300,
    "age_sec": 900,
    "stale": true
  },
  "terminal_result": {
    "present": false
  },
  "next_steps": [
    "Confirm the recorded worker process is no longer executing this job.",
    "Archive execution.lock for audit before removing it.",
    "Remove only execution.lock, then resume according to the delivery mode."
  ]
}
```

Example ineligible output when a terminal result already exists:

```json
{
  "schema_version": 1,
  "command": "recover-lock",
  "dry_run": true,
  "job_id": "job_done_lock",
  "eligible": false,
  "reason": "terminal_result_exists",
  "stale_after_sec": 300,
  "execution_lock": {
    "present": true,
    "worker_id": "local-001",
    "pid": 123,
    "acquired_at": "2026-06-18T00:00:00.000Z",
    "stale_after_sec": 300,
    "age_sec": 900,
    "stale": true
  },
  "terminal_result": {
    "present": true,
    "status": "COMPLETED",
    "reason": null
  },
  "next_steps": [
    "Preserve the existing terminal result; do not remove the lock for rerun recovery."
  ]
}
```

When `reason` is `terminal_result_exists`, do not remove `execution.lock` to force a rerun. A terminal result is already the recorded outcome, so deleting the lock can create duplicate or contradictory execution history.

## 6. Future Mutating Recovery Contract

A future mutating mode may automate the manual steps:

```bash
git-runner recover-lock <job-id> \
  [--stale-after-sec 300] \
  [--archive] \
  [--force]
```

Required behavior:

- Without `--force`, the command must not remove `execution.lock`.
- The command must refuse recovery when no lock exists.
- The command must refuse recovery when a terminal `result-summary.json` exists unless a future explicit terminal-cleanup option is defined.
- The command must refuse recovery when the lock is not stale for the selected threshold unless `--force` is present.
- If `--archive` is present, the command must move the lock to `execution.lock.recovered-<timestamp>` instead of deleting it.
- The command must never delete job result, log, artifact, or job spec files.

## 7. Non-Goals

- No automatic stale lock release.
- No automatic job retry from `status`.
- No cross-host process liveness detection.
- No NATS JetStream consumer reset or stream purge operation.
