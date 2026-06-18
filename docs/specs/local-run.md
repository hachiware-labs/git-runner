# Local Run Spec

## 1. Goal

`git-runner local run` executes a job spec in an existing local workspace without NATS, JetStream, worker auth, or Git clone/fetch. It is for fast local validation before using distributed workers.

Primary user value:

- validate params passing;
- validate result schema;
- validate artifact declarations;
- produce a Research Booster importable Result Bundle;
- debug job contracts without starting NATS infrastructure.

## 2. Command

```bash
git-runner local run <job.json> \
  [--workspace .] \
  [--bundle .git-runner/result-bundle.json] \
  [--worker-id local-001]
```

MVP defaults:

| Option | Default | Description |
| --- | --- | --- |
| `<job.json>` | required | Job Spec JSON file. |
| `--workspace <path>` | `.` | Existing workspace root where commands run. |
| `--bundle <path>` | `.git-runner/result-bundle.json` | Output Result Bundle path. |
| `--worker-id <id>` | `local-001` | Worker id written to bundle metadata. |

Exit behavior:

- exit `0` when bundle status is `COMPLETED`;
- exit non-zero when bundle status is `FAILED` or `CANCELLED`;
- still write a bundle when possible for failed executions.

## 3. Non-Goals

- NATS transport;
- JetStream delivery;
- Git clone/fetch/checkout;
- worker auth;
- execution lock;
- remote object storage;
- multiple concurrent jobs.

These remain distributed worker concerns.

## 4. Supported Job Fields

`local run` consumes the same schema version `1` Job Spec used by distributed workers, with compatibility normalization defined in section 5.

MVP-supported fields:

- `source.type: "git"` metadata is preserved but not executed;
- `source.repo`, `source.branch`, `source.commit`;
- `working_dir`;
- `setup[]`;
- `entry.type: "command"`;
- `entry.command`;
- `params` object;
- `param_passing.mode: "json_file"`;
- `param_passing.path`;
- `outputs.result.path`;
- `outputs.result.schema.type: "none" | "json_schema"`;
- `outputs.result.schema.file`;
- `outputs.artifacts[]`;
- `execution.timeout_sec`;
- `execution.max_stdout_bytes`;
- `execution.max_stderr_bytes`;
- `worker.tags[]` or `worker.routing_tag`;
- `runtime.type: "host"` when present.

## 5. Compatibility Normalization

Research Booster's local runner fixture uses a narrow contract that differs slightly from the current distributed-worker Job Spec. `local run` must normalize these inputs before execution:

### 5.1 Setup Entries

Accepted forms:

```json
["python --version"]
```

```json
[{ "type": "command", "command": "python --version" }]
```

Both normalize to command setup entries. Empty setup commands are invalid.

### 5.2 Worker Routing Tag

Accepted forms:

```json
{ "worker": { "tags": ["default"] } }
```

```json
{ "worker": { "routing_tag": "default" } }
```

`worker.routing_tag` in the bundle is:

1. `job.worker.routing_tag` when provided;
2. else `job.worker.tags[0]`;
3. else `default`.

### 5.3 Runtime

If `runtime` is missing, `local run` treats it as:

```json
{ "type": "host" }
```

Any non-host runtime remains unsupported for MVP.

### 5.4 Params File Shape

Distributed executor writes:

```json
{
  "job_id": "job_001",
  "params": {}
}
```

`local run` must use the same shape to keep command behavior consistent across local and distributed modes.

## 6. Execution Flow

1. Read and normalize the job spec.
2. Resolve `--workspace` to an existing directory.
3. Resolve `working_dir` under workspace.
4. Write params according to `param_passing`.
5. Run setup commands in order.
6. Run entry command when setup succeeds.
7. Capture stdout and stderr up to configured byte limits.
8. Read and validate result output.
9. Check artifacts.
10. Write a terminal Result Bundle.

## 7. Status and Reason Priority

When multiple problems occur, use this priority:

1. `invalid_job_spec`
2. `setup_failed`
3. `timeout`
4. `result_missing`
5. `result_invalid`
6. `artifact_missing`
7. `command_failed`
8. `COMPLETED`

This priority keeps contract problems visible even when the process exits unsuccessfully.

## 8. Result Bundle

`local run` writes `git-runner.result-bundle.v1` as defined in [result-bundle.md](result-bundle.md).

Required Research Booster-compatible fields:

- `outputs.result.value` contains parsed result JSON when a result exists;
- `outputs.result.schema` preserves the job output schema config;
- `worker.worker_id` is set from `--worker-id`;
- `worker.routing_tag` is set by compatibility normalization;
- `job.params` is preserved;
- `source.repo`, `source.branch`, and `source.commit` are preserved.

## 9. Acceptance Fixture

The initial acceptance fixture is [examples/research-booster-local-runner/local-runner-acceptance.json](../../examples/research-booster-local-runner/local-runner-acceptance.json).

It is a path-rebased snapshot derived from Research Booster's `git-runner-research-booster-e2e` fixture and is accepted as git-runner's local runner contract. The fixture records its source brief, source acceptance fixture, reference mock, and path rewrite metadata so drift can be reviewed explicitly.

The fixture includes a representative draft 2020-12 `research-booster.v1` schema at [examples/research-booster-local-runner/schemas/research-booster.v1.schema.json](../../examples/research-booster-local-runner/schemas/research-booster.v1.schema.json), so git-runner can run local-run acceptance without depending on the external Research Booster repository.
