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
- `git-runner worker --once`
- NATS job publish and worker subscribe
- detached checkout of `source.commit`
- worker policy checks for tags and repositories
- timeout and cancellation handling
- stdout/stderr capture with truncation metadata
- optional result JSON and JSON Schema validation
- artifact collection
- local `status`, `logs`, and `get`

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

Initialize project config:

```bash
node bin/git-runner.js init
```

Submit a job:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

The output includes a `job_id`. In another terminal, run a one-job worker:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

Inspect the job:

```bash
node bin/git-runner.js status <job-id>
node bin/git-runner.js logs <job-id>
node bin/git-runner.js get <job-id> --json
```

For a complete walkthrough, see [docs/tutorial.md](docs/tutorial.md).

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
  artifacts/
```

`status`, `logs`, and `get` read from this local store. The MVP assumes the submitter, worker, and inspection commands use the same host or a shared filesystem.

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
npm test
```

The test suite includes local CLI tests plus NATS-backed integration tests when a local NATS server binary is available.

## Documentation

- [Japanese README](README_ja.md)
- [English tutorial](docs/tutorial.md)
- [Japanese tutorial](docs/tutorial_ja.md)
- [Document index](docs/README.md)
- [PRD](docs/prd.md)
- [Architecture spec](docs/specs/architecture.md)
- [CLI spec](docs/specs/cli.md)
- [Error catalog](docs/specs/error-catalog.md)
- [ADR index](docs/adr/README.md)
