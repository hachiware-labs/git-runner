# Error Catalog

## 1. Overview

This catalog defines every MVP failure condition that affects CLI command exit, job status, or worker lifecycle.

Two classes of failures exist:

- CLI failures: command fails before a job reaches worker execution.
- Job failures: job reaches worker handling and receives terminal `FAILED` or `CANCELLED` status.

Status reasons are stable API values. Human-readable messages may change, but reason strings must remain stable within schema version `1`.

## 2. CLI Exit Codes

| Exit Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | generic failure |
| `2` | invalid CLI usage or invalid config |
| `3` | Git operation failed before job publish |
| `4` | NATS operation failed |
| `5` | local job store operation failed |

## 3. Job Reasons

| Reason | Terminal Status | Owner | Automatic Retry | Description |
| --- | --- | --- | --- | --- |
| `job_invalid` | `FAILED` | worker supervisor | no | Job Spec is malformed or unsupported. |
| `worker_policy_denied` | `FAILED` | worker supervisor | no | Job violates worker policy such as tags or repository allowlist. |
| `git_checkout_failed` | `FAILED` | worker supervisor | no | Repository clone/fetch/checkout of `source.commit` failed. |
| `command_failed` | `FAILED` | executor/supervisor | no | setup or entry command exited non-zero, or executor crashed without timeout. |
| `timeout` | `FAILED` | worker supervisor | no | executor exceeded `execution.timeout_sec` and was killed. |
| `result_missing` | `FAILED` | worker supervisor | no | required result file is missing for `json_schema` output. |
| `result_invalid` | `FAILED` | worker supervisor | no | result file is invalid JSON or fails JSON Schema validation when schema is required. |
| `cancelled` | `CANCELLED` | worker supervisor | no | job was cancelled before terminal completion. |

MVP does not perform automatic retry. Users can submit a new job explicitly.

`worker_auth_failed` is reserved for a future authenticated worker protocol and is not emitted by MVP. MVP worker key failures are CLI/worker startup failures, not job terminal statuses.

## 4. CLI Failure Catalog

| Condition | Command | Exit Code | Job Published | Required Message Content |
| --- | --- | --- | --- | --- |
| unknown command | any | `2` | no | valid command list |
| missing required option | any | `2` | no | missing option name |
| config file invalid JSON | any using config | `2` | no | config path and parse error |
| unsupported config schema | any using config | `2` | no | schema version |
| `submit --command` missing | `submit` | `2` | no | `--command` |
| `submit --timeout-sec` is not a positive integer | `submit` | `2` | no | `--timeout-sec` |
| `submit --jetstream` is combined with `--no-require-worker` | `submit` | `2` | no | conflicting options |
| params file is missing, unreadable, invalid JSON, or not an object | `submit` | `2` | no | params path |
| `submit --repo` is not a Git repository | `submit` | `3` | no | repo path |
| `submit --commit` cannot be resolved | `submit` | `3` | no | commit value |
| `submit --branch` cannot be resolved | `submit` | `3` | no | branch value |
| dirty working tree without `--commit-and-push` | `submit` | `0` | yes | warning that uncommitted changes are excluded |
| detached HEAD with `--commit-and-push` and no `--branch` | `submit` | `3` | no | require `--branch` |
| `git add -A` fails | `submit --commit-and-push` | `3` | no | git stderr summary |
| commit fails | `submit --commit-and-push` | `3` | no | git stderr summary |
| push fails | `submit --commit-and-push` | `3` | no | git stderr summary |
| NATS connect, publish, or JetStream setup fails | `submit` | `4` | no | NATS URL and operation |
| no matching worker accepts core submit dispatch | `submit` | `4` | no | routing tag, default core mode, and `--no-require-worker` or `--jetstream` alternative |
| local job store write fails | `submit`, `worker`, `status`, `logs`, `get` | `5` | no | path and operation |
| `worker --worker-id` missing and config missing | `worker` | `2` | no | `worker_id` |
| worker key missing | `worker` | `2` | no | `--worker-key` or `GIT_RUNNER_WORKER_KEY` |
| worker NATS connect fails | `worker` | `4` | no | NATS URL |
| worker JetStream consumer setup fails | `worker` | `4` | no | stream/consumer setup and NATS URL |
| `status` job id missing | `status` | `2` | no | job id |
| `logs` job id missing | `logs` | `2` | no | job id |
| `get` job id missing | `get` | `2` | no | job id |
| job not found in local job store | `status`, `logs`, `get` | `5` | no | job id and `job_store_root` |

## 5. Job Validation Failures

These failures occur after a worker receives a job. The worker writes terminal status when it can identify `job_id`; if `job_id` itself is missing or invalid, the worker logs the rejection and publishes no job-scoped terminal event.

| Condition | Reason |
| --- | --- |
| `schema_version` missing or unsupported | `job_invalid` |
| `job_id` missing or empty | `job_invalid` |
| `source.type` is not `git` | `job_invalid` |
| `source.repo` missing or empty | `job_invalid` |
| `source.commit` missing or empty | `job_invalid` |
| `working_dir` escapes repository root | `job_invalid` |
| setup entry type unsupported | `job_invalid` |
| setup command empty | `job_invalid` |
| `entry.type` is not `command` | `job_invalid` |
| `entry.command` empty | `job_invalid` |
| `params` is not a JSON object | `job_invalid` |
| `param_passing.mode` is not `json_file` | `job_invalid` |
| `param_passing.path` escapes repository root | `job_invalid` |
| output result path escapes repository root | `job_invalid` |
| output schema type unsupported | `job_invalid` |
| output schema file path escapes repository root | `job_invalid` |
| artifact path escapes repository root | `job_invalid` |
| `execution.timeout_sec` is not positive | `job_invalid` |
| stdout/stderr limits are not positive | `job_invalid` |
| `runtime.type` is not `host` | `job_invalid` |

## 6. Worker Policy Failures

| Condition | Reason |
| --- | --- |
| job routing tag is not in `allowed_tags` | `worker_policy_denied` |
| job repository is not in `allowed_repos` and `allow_all_repos` is false | `worker_policy_denied` |
| absolute job-controlled path is provided | `worker_policy_denied` |

## 7. Git Failures

All worker-side Git failures below map to `git_checkout_failed`.

| Condition | Reason |
| --- | --- |
| clone from `source.repo` fails | `git_checkout_failed` |
| fetch fails | `git_checkout_failed` |
| checkout detached `source.commit` fails | `git_checkout_failed` |
| workspace directory cannot be prepared | `git_checkout_failed` |

## 8. Command and Executor Failures

| Condition | Status | Reason |
| --- | --- | --- |
| setup command exits non-zero | `FAILED` | `command_failed` |
| entry command exits non-zero | `FAILED` | `command_failed` |
| executor process exits without result summary | `FAILED` | `command_failed` |
| executor process is killed by supervisor timeout | `FAILED` | `timeout` |
| stdout exceeds limit | unchanged | no failure; set `stdout_truncated: true` |
| stderr exceeds limit | unchanged | no failure; set `stderr_truncated: true` |

## 9. Result Failures

| Condition | Output Schema | Status | Reason |
| --- | --- | --- | --- |
| result file missing | `none` | unchanged | no failure |
| result file valid JSON | `none` | unchanged | no failure |
| result file invalid JSON | `none` | unchanged | no failure; add `optional_result_invalid_json` warning |
| result file missing | `json_schema` | `FAILED` | `result_missing` |
| result file invalid JSON | `json_schema` | `FAILED` | `result_invalid` |
| schema file missing | `json_schema` | `FAILED` | `result_invalid` |
| schema file invalid JSON Schema | `json_schema` | `FAILED` | `result_invalid` |
| result fails JSON Schema validation | `json_schema` | `FAILED` | `result_invalid` |

## 10. Cancellation

MVP status model includes `CANCELLED`. MVP cancellation is event-driven through `git-runner.cancels.<job-id>` and does not require a user-facing CLI command.

- running job cancellation maps to `CANCELLED` with `cancelled` and requires supervisor to terminate executor.
- pending or accepted job cancellation is not guaranteed in MVP because cancel subjects are core NATS messages and are not durable.
- cancellation cleanup follows the same artifact/log preservation rules as failure.
