# git-runner

`git-runner` runs a command against a pinned Git commit on a worker, then stores the job status, logs, result JSON, and artifacts in a local job store.

The MVP is intentionally narrow:

- submit a Git-backed job to NATS
- resolve branches to commit SHAs at submit time
- execute only the pinned commit on the worker
- collect stdout, stderr, exit status, optional result JSON, and artifacts
- keep experiment meaning, findings, and recommendations outside this runner

Japanese documentation is available in [README_ja.md](README_ja.md).

## Why

Branch names move. `git-runner` fixes execution to a commit SHA so an experiment, benchmark, or test run can be reproduced later. A branch may be kept as provenance, but the worker never resolves a branch to decide what code to execute.

## Current Status

Implemented MVP capabilities:

- `git-runner init`
- `git-runner submit`
- `git-runner submit --dry-run`
- `git-runner submit --commit-and-push`
- `git-runner submit --jetstream`
- `git-runner worker --once`
- NATS job publish and worker subscribe
- optional JetStream-backed durable job delivery
- detached checkout of `source.commit`
- worker policy checks for tags and repositories
- timeout and cancellation handling
- stdout/stderr capture with truncation metadata
- optional result JSON and JSON Schema validation
- artifact collection
- local `status`, `logs`, and `get`
- read-only `recover-lock` stale lock inspection
- `git-runner local run` for existing-workspace Job Spec validation and Result Bundle output
- `git-runner get --bundle` for exporting terminal worker results as Result Bundles
- `git-runner validate-bundle` for checking Result Bundle shape before import

Out of scope for the MVP:

- web dashboard
- production artifact object storage
- multi-machine result retrieval without shared storage
- command allowlist
- container runtime isolation
- authenticated worker protocol beyond the local worker key requirement

## Requirements

- Node.js 22 or newer
- Git
- NATS server for non-dry-run submit/worker flows
- NATS server with JetStream enabled when using `--jetstream`

Install dependencies from this checkout:

```bash
npm install
```

Run the CLI directly:

```bash
node bin/git-runner.js --help
```

Or link it locally:

```bash
npm link
git-runner --help
```

## Quick Start

Start NATS in one terminal:

```bash
nats-server
```

Start a one-job worker in another terminal and leave it waiting:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

Initialize project config:

```bash
node bin/git-runner.js init
```

Submit a job:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

The output includes a `job_id`. The waiting worker processes the job and exits.

Inspect the job:

```bash
node bin/git-runner.js status <job-id>
node bin/git-runner.js logs <job-id>
node bin/git-runner.js get <job-id> --json
```

Export a terminal worker result as a portable Result Bundle:

```bash
node bin/git-runner.js get <job-id> --bundle
```

If no bundle path is provided, the file is written to `.git-runner/jobs/<job-id>/result-bundle.json`. Bundles keep logs and artifacts as metadata instead of embedding large file contents. Result JSON is embedded only when it fits the default 256 KiB inline budget; larger results stay available as files and are reported with `result_warning: result_omitted_from_bundle`.

Validate a Result Bundle before importing it elsewhere:

```bash
node bin/git-runner.js validate-bundle .git-runner/jobs/<job-id>/result-bundle.json
```

For a complete walkthrough, see [docs/tutorial.md](docs/tutorial.md).

Important: the MVP uses NATS core request/reply for default job dispatch, not a durable queue. By default, `submit` requires a matching worker to accept the job message before returning. If no worker accepts it, submit fails and does not leave a pending job. Use `--no-require-worker` only when you intentionally want to bypass this guard.

For durable local delivery, start NATS with JetStream and pass `--jetstream` to both submit and worker:

```bash
nats-server -js
node bin/git-runner.js submit --repo . --command "npm test" --jetstream
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --jetstream --once
```

In JetStream mode, `submit` stores the job in stream `GIT_RUNNER_JOBS`; a matching worker can start after submit and still receive the job. Delivery is at-least-once. Workers use a local job store execution lock to avoid duplicate execution after redelivery or multi-worker delivery when they share the same `job_store_root`, but commands should still be safe to rerun if a worker crashes before writing a terminal result.

If a worker accepts a job and then crashes before validation or execution, the latest status may remain `ACCEPTED`. That indicates the job was delivered to a worker but no terminal result was recorded.

Use `status --stale-after-sec <seconds>` to detect an `ACCEPTED` job or `execution.lock` that has not advanced. This is diagnostic only; the MVP does not retry stale jobs or release stale locks automatically.
For manual stale lock recovery rules, see [docs/specs/recovery.md](docs/specs/recovery.md).

Inspect stale lock recovery preconditions without mutating the job store:

```bash
node bin/git-runner.js recover-lock <job-id> --stale-after-sec 300
```

`recover-lock` is read-only. It prints `dry_run: true`, `eligible`, `reason`, lock metadata, terminal-result presence, and `next_steps`. Treat `eligible: true` as a prompt for operator review, not as proof that the lock is safe to delete. Before removing or archiving `execution.lock`, confirm the recorded worker process is no longer running and preserve the lock metadata for audit.

Validate a Job Spec in an existing workspace without NATS or Git checkout:

```bash
node bin/git-runner.js local run job.json --workspace . --bundle .git-runner/result-bundle.json
```

`local run` writes a `git-runner.result-bundle.v1` Result Bundle and returns a non-zero exit code when the bundle status is `FAILED` or `CANCELLED`.

## Common Commands

Create default config:

```bash
node bin/git-runner.js init
```

Preview the Job Spec without publishing:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --dry-run --json
```

Submit the current committed state:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

For this to execute, at least one matching worker must already be subscribed to the NATS subject.

Bypass the worker dispatch guard:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --no-require-worker
```

With the guard disabled, `submit` uses publish-only delivery and NATS core does not retain the job for a worker that subscribes later.

Use JetStream durable delivery:

```bash
nats-server -js
node bin/git-runner.js submit --repo . --command "npm test" --jetstream
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --jetstream --once
```

Run a Job Spec locally and emit a Result Bundle:

```bash
node bin/git-runner.js local run job.json --workspace . --json
```

Commit and push changes before submitting:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --branch codex/exp-001 --commit-and-push --message "Prepare experiment"
```

Run a worker that only accepts explicit repositories:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-repo C:\path\to\repo --once
```

## Job Store

The MVP stores job data under:

```text
.git-runner/jobs/<job-id>/
  status.json
  stdout.log
  stderr.log
  result-summary.json
  execution.lock/
  artifacts/
```

`status`, `logs`, and `get` read from this local store. The MVP assumes the submitter, worker, and inspection commands use the same host or a shared filesystem.
`execution.lock/` is internal and exists while a worker owns job execution.

## Git Rules

- `--commit` wins over `--branch`.
- Without `--commit`, `--branch` is resolved to a commit SHA at submit time.
- Without both, the current `HEAD` is used.
- The worker checks out `source.commit` as detached `HEAD`.
- `submit` never commits or pushes unless `--commit-and-push` is provided.
- Dirty working tree changes are not included unless committed first.

## Development

Run checks:

```bash
npm run check
npm run test:local
npm test
```

Use `npm run check` after code edits to catch syntax errors quickly. Use `npm run test:local` for the usual fast NATS-free loop; it covers `local run`, Result Bundle validation, executor behavior, and local job-store reads. Use `npm test` before pushing or when touching submit/worker/NATS behavior; it includes local tests plus NATS-backed integration tests when a local NATS server binary is available.

CI runs the same order: syntax check, local contract tests, then the full test suite.

## Documentation

- [Japanese README](README_ja.md)
- [English tutorial](docs/tutorial.md)
- [Japanese tutorial](docs/tutorial_ja.md)
- [Document index](docs/README.md)
- [PRD](docs/prd.md)
- [Architecture spec](docs/specs/architecture.md)
- [CLI spec](docs/specs/cli.md)
- [Error catalog](docs/specs/error-catalog.md)
- [Local run spec](docs/specs/local-run.md)
- [Result Bundle spec](docs/specs/result-bundle.md)
- [ADR index](docs/adr/README.md)
