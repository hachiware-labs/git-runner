# Architecture Spec

## 1. Overview

`git-runner` is a layered execution system. Each layer has a narrow responsibility so that implementation choices are deterministic and failures map to defined status reasons.

```text
Research Booster or human user
  |
  v
git-runner CLI
  init / submit / status / logs / get / worker
  |
  +-- submitter
  |     Git repository inspection
  |     ref resolution to commit SHA
  |     Job Spec creation
  |     NATS core or JetStream job dispatch
  |
  +-- inspection commands
  |     read local job store
  |
  v
NATS transport
  job subjects
  status/log/result events
  worker heartbeat
  |
  v
worker supervisor
  worker config and policy
  NATS subscription
  workspace preparation
  git fetch and detached checkout
  executor process lifecycle
  timeout enforcement
  status/log/result publication
  local job store writes
  |
  v
executor process
  params file write
  setup command execution
  entry command execution
  stdout/stderr capture
  result file read
  executor summary return
  |
  v
checked-out Git workspace
  source.commit detached HEAD
  working_dir
  .git-runner/params.json
  .git-runner/result.json
  artifacts
```

## 2. Layers and Responsibilities

| Layer | Owns | Must Not Own |
| --- | --- | --- |
| Research Booster | experiment meaning, result interpretation, Finding, Recommendation | Git checkout, worker process management, command execution |
| CLI submitter | repository inspection, ref resolution, Job Spec creation, NATS job dispatch | worker policy decision, command execution |
| NATS transport | message transport, subject routing, default JetStream job durability | job semantics, result interpretation, NATS server lifecycle |
| worker supervisor | job acceptance, policy validation, workspace lifecycle, git checkout, executor lifecycle, timeout, terminal status mapping | direct command execution, Research Booster semantics |
| executor process | setup and entry command execution in a checked-out workspace | NATS connection, job routing, worker policy |
| local job store | persisted job spec, latest status, logs, result summary, artifacts | distributed storage without shared filesystem |

## 3. Data Flow

### 3.1 Submit Flow

1. CLI loads project config.
2. CLI inspects local Git repository.
3. CLI resolves execution commit:
   1. explicit `--commit`
   2. else explicit `--branch`
   3. else current `HEAD`
4. CLI optionally performs `--commit-and-push`.
5. CLI records local submit metadata under the configured `job_store_root`.
6. CLI dispatches Job Spec to `git-runner.jobs.<routing-tag>`.
   - By default this publishes to JetStream stream `GIT_RUNNER_JOBS` for durable at-least-once delivery.
   - `--jetstream` is accepted as an explicit spelling of the default.
   - With `--delivery-mode core`, this uses NATS request/reply and requires a worker acceptance response.
   - With `--delivery-mode core --no-require-worker`, this uses core publish-only delivery.
7. CLI prints `job_id`, `commit`, and subject.

Submitter never executes the job command.

### 3.2 Worker Flow

1. Worker loads worker config.
2. Worker validates that worker key is present.
3. Worker connects to NATS.
4. Worker binds JetStream durable consumers for configured tags, or subscribes to core job subjects when core delivery is selected.
5. Worker receives a Job Spec.
6. Worker acquires the job store execution lock when `job_id` is valid.
7. If a terminal result already exists for the job, worker skips execution.
8. Worker writes and publishes `ACCEPTED` after acquiring the execution lock.
9. Worker responds to request/reply dispatch when a reply subject is present.
10. Worker validates schema and policy.
11. Worker publishes `RUNNING`.
12. Worker prepares per-job workspace.
13. Worker fetches repository and checks out `source.commit` as detached HEAD.
14. Worker starts executor process.
15. Worker enforces timeout.
16. Worker listens for cancellation on `git-runner.cancels.<job-id>` while the executor is running.
17. Worker maps executor result to terminal status and reason.
18. Worker validates result file when required.
19. Worker collects artifacts.
20. Worker writes terminal result summary.
21. Worker publishes terminal status and result.
22. Worker cleans workspace according to cleanup policy.
23. Worker releases the execution lock.

Worker supervisor never runs setup or entry commands in-process.

### 3.3 Executor Flow

1. Executor receives an executor request from supervisor.
2. Executor resolves `working_dir` under workspace root.
3. Executor writes params file.
4. Executor runs setup commands in order.
5. Executor runs entry command if setup succeeds.
6. Executor writes stdout/stderr logs.
7. Executor records exit code, signal, and duration.
8. Executor reads result file if present.
9. Executor returns summary to supervisor.

Executor never connects to NATS and never decides worker policy.

## 4. Storage Model

MVP uses local filesystem storage:

```text
.git-runner/jobs/<job-id>/
  job-spec.json
  status.json
  stdout.log
  stderr.log
  result-summary.json
  execution.lock/
  artifacts/
```

The same `job_store_root` must be readable by `status`, `logs`, and `get`.

MVP deployment modes:

- single host: submitter, worker, and inspection commands run on the same host.
- shared filesystem: multiple processes can access the same `job_store_root`.

Out of MVP scope:

- result retrieval across machines without shared storage.
- NATS Object Store.
- HTTP artifact upload.

## 5. Authority Rules

- `source.commit` is the only execution authority.
- `source.branch` is provenance only.
- worker must not resolve branch to decide what to execute.
- command exit status is the base execution outcome.
- result schema validation can turn a successful command into `FAILED`.
- optional result JSON parse warnings do not fail a successful command when schema type is `none`.
- worker policy validation happens before workspace preparation.

## 6. Failure Boundaries

| Failure Boundary | Owner | Expected Behavior |
| --- | --- | --- |
| invalid CLI input | CLI | fail before publishing a job |
| NATS dispatch/connect failure | CLI or worker | fail command or worker startup; no fake success |
| worker crash after dispatch acceptance | worker supervisor boundary | latest local status may remain `ACCEPTED`; no automatic retry in MVP |
| worker crash before JetStream ack | NATS transport / worker supervisor boundary | JetStream may redeliver the job; job command must tolerate at-least-once execution |
| duplicate delivery while another worker holds lock | local job store | duplicate worker does not execute the command |
| duplicate delivery after terminal result exists | local job store | duplicate worker skips execution and preserves existing terminal result |
| invalid Job Spec | worker supervisor | terminal `FAILED` with `job_invalid` |
| worker policy denial | worker supervisor | terminal `FAILED` with `worker_policy_denied` |
| clone/fetch/checkout failure | worker supervisor | terminal `FAILED` with `git_checkout_failed` |
| setup/entry non-zero exit | executor, mapped by supervisor | terminal `FAILED` with `command_failed` |
| timeout | supervisor | kill executor; terminal `FAILED` with `timeout` |
| required result missing/invalid | supervisor result validation | terminal `FAILED` with `result_missing` or `result_invalid` |
| cancellation | supervisor | stop executor when running; terminal `CANCELLED` with `cancelled` |

The authoritative error mapping is [error-catalog.md](error-catalog.md).
