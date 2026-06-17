# Security and Policy Spec

## 1. Threat Model

Worker executes arbitrary commands from Git repositories. MVP assumes workers run in trusted environments, but must still provide basic controls to prevent accidental execution of unauthorized jobs.

MVP does not provide strong sandboxing. Host runtime means command execution can affect the worker host according to OS user permissions.

Policy failures and their status reasons are defined in [error-catalog.md](error-catalog.md).

## 2. Required Controls

MVP controls:

- worker key
- worker id
- allowed tags
- allowed repositories
- timeout
- max stdout/stderr bytes
- workspace cleanup
- executor process isolation

Command allowlist is not required for MVP.

## 3. Worker Key

Worker must be started with a worker key:

```bash
git-runner worker --worker-key $GIT_RUNNER_WORKER_KEY
```

or:

```powershell
$env:GIT_RUNNER_WORKER_KEY = "..."
git-runner worker
```

MVP worker key behavior:

- Worker refuses to start when no worker key is provided.
- Worker key is treated as a local worker credential and must not be written to logs, job specs, status events, or result files.
- NATS server authentication is configured outside `git-runner`; if the NATS URL or credentials require authentication, the NATS client uses that external configuration.
- MVP does not put worker key into job specs and does not use it as a job routing secret.
- Production hardening should add NATS account/user credentials or signed job envelopes.

## 4. Allowed Tags

Worker config:

```json
{
  "tags": ["default"],
  "allowed_tags": ["default", "gpu-large"]
}
```

Rules:

- Worker subscribes only to configured `tags`.
- Worker rejects jobs whose requested tags are not allowed.
- MVP routing uses `job.worker.tags[0]`.
- Tag rejection maps to `FAILED` with `worker_policy_denied`.

## 5. Allowed Repositories

Worker config:

```json
{
  "allowed_repos": [
    "git@github.com:user/project.git",
    "https://github.com/user/project.git"
  ]
}
```

Rules:

- If `allowed_repos` is non-empty, `job.source.repo` must match one allowed repository.
- If `allowed_repos` is empty or omitted, worker defaults to deny-all.
- Local development can opt into permissive behavior with explicit `--allow-all-repos`.
- `--allow-all-repos` must be visible in startup logs and heartbeat metadata as `allow_all_repos: true`.
- Repository rejection maps to `FAILED` with `worker_policy_denied`.

## 6. Path Safety

Worker must normalize and validate these paths:

- `working_dir`
- `param_passing.path`
- `outputs.result.path`
- `outputs.result.schema.file`
- artifact paths

Paths must not escape repository root.

Absolute paths in job spec must be rejected for MVP.

## 7. Timeout and Output Limits

Worker must enforce:

- `execution.timeout_sec`
- `execution.max_stdout_bytes`
- `execution.max_stderr_bytes`

If timeout is exceeded, job fails with `timeout`.

If stdout/stderr exceeds max bytes, logs are truncated and truncation metadata is recorded.

## 8. Workspace Cleanup

Default cleanup mode is `after_job`.

Workers must keep enough metadata outside the deleted workspace so that `status`, `logs`, and `get` can still return terminal job information.

## 9. Future Hardening

Future versions may add:

- Docker runtime
- command allowlist
- per-repository credentials policy
- signed job specs
- NATS account based authentication
- resource limits beyond timeout/log size
- artifact upload allowlist
