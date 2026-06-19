# git-runner Manual

This manual explains how to operate `git-runner` from setup through job execution, inspection, Result Bundle export, recovery checks, and development verification.

For a short first run, use [tutorial.md](tutorial.md). For implementation contracts, use [specs/](specs/).

## 1. What git-runner Does

`git-runner` runs a command against a pinned Git commit on a worker. It records job state, stdout, stderr, result JSON, and artifacts in a local job store.

The key rule is that execution is pinned to a commit SHA:

- `--commit` wins over `--branch`.
- If `--commit` is omitted and `--branch` is provided, submit resolves that branch to a commit SHA at submit time.
- If both are omitted, submit resolves the current `HEAD`.
- The worker checks out `source.commit` as detached `HEAD`.

Default job delivery uses NATS JetStream. This means `submit` can store a durable pending job before a worker is running.

## 2. Requirements

- Node.js 22 or newer
- Git
- NATS server
- JetStream enabled for the normal submit/worker flow

Install dependencies:

```bash
npm install
```

Run the CLI from the checkout:

```bash
node bin/git-runner.js --help
```

Optionally link it locally:

```bash
npm link
git-runner --help
```

## 3. Configuration

Create the project config:

```bash
node bin/git-runner.js init
```

Default path:

```text
.git-runner/config.json
```

Important project config fields:

- `nats_url`: NATS server URL.
- `delivery_mode`: defaults to `jetstream`.
- `default_worker_tags`: routing tags used when `--worker-tags` is omitted.
- `param_passing`: where the executor writes job params.
- `outputs.result`: result JSON path and optional schema.
- `outputs.artifacts`: files or directories to collect.
- `execution`: timeout and log byte limits.
- `job_store_root`: local job store root.

Worker config can be supplied through `.git-runner/worker.json`, but local development often passes worker options on the command line.

Worker key is not written by `init`; provide it with `--worker-key` or `GIT_RUNNER_WORKER_KEY`.

## 4. NATS and Delivery Modes

Start NATS with JetStream:

```bash
nats-server -js
```

Default delivery:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

JetStream delivery stores jobs in stream `GIT_RUNNER_JOBS`. Delivery is at-least-once, so job commands should tolerate rerun if a worker crashes before writing a terminal result. The local job store execution lock prevents duplicate execution when workers share the same `job_store_root`.

Legacy core delivery is still available:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --delivery-mode core
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --delivery-mode core --once
```

Core delivery requires a matching worker to accept the job before `submit` returns. `--no-require-worker` is valid only with core delivery:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --delivery-mode core --no-require-worker
```

## 5. Submitting Jobs

Preview a Job Spec without writing the job store or publishing to NATS:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --dry-run --json
```

Submit current `HEAD`:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

Submit a branch, resolved once at submit time:

```bash
node bin/git-runner.js submit --repo . --branch main --command "npm test"
```

Submit an explicit commit:

```bash
node bin/git-runner.js submit --repo . --commit <sha> --command "npm test"
```

Commit and push before submitting:

```bash
node bin/git-runner.js submit --repo . --branch codex/exp-001 --commit-and-push --message "Prepare experiment" --command "npm test"
```

`submit` warns when the working tree is dirty and `--commit-and-push` is not used. Dirty changes are not included in the job unless committed first.

## 6. Running Workers

Run one job and exit:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

Accept only specific repositories:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-repo C:\path\to\repo --once
```

Use routing tags:

```bash
node bin/git-runner.js submit --repo . --worker-tags gpu --command "npm test"
node bin/git-runner.js worker --worker-id gpu-001 --worker-key dev --tags gpu --allow-all-repos --once
```

Workers validate:

- worker key presence;
- allowed tags;
- allowed repositories;
- Job Spec shape;
- result schema when configured.

## 7. Inspecting Jobs

Read latest status:

```bash
node bin/git-runner.js status <job-id>
```

Read logs:

```bash
node bin/git-runner.js logs <job-id>
node bin/git-runner.js logs <job-id> --stderr
```

Read terminal result summary:

```bash
node bin/git-runner.js get <job-id> --json
```

The job store layout is:

```text
.git-runner/jobs/<job-id>/
  status.json
  stdout.log
  stderr.log
  result-summary.json
  execution.lock/
  artifacts/
```

The submitter, worker, and inspection commands should use the same host or shared filesystem for the MVP.

## 8. Result JSON, Artifacts, and Bundles

A command can write result JSON at the configured `outputs.result.path`. If a JSON Schema is configured, the worker validates the result after the command exits.

Artifacts are configured as named output paths and are copied into the job store after execution.

Export a terminal worker result as a Result Bundle:

```bash
node bin/git-runner.js get <job-id> --bundle
```

Validate a Result Bundle:

```bash
node bin/git-runner.js validate-bundle .git-runner/jobs/<job-id>/result-bundle.json
```

Bundles are designed for web-sized import. Logs and artifacts are represented as metadata. Result JSON is embedded only within the inline size budget; oversized values are omitted from the bundle and reported with a warning.

## 9. Local Run

`local run` executes a Job Spec in an existing workspace without NATS, worker auth, execution lock, or Git checkout. Use it for fast contract validation.

```bash
node bin/git-runner.js local run job.json --workspace . --bundle .git-runner/result-bundle.json --json
```

`local run` writes a `git-runner.result-bundle.v1` Result Bundle. It exits non-zero when the bundle status is `FAILED` or `CANCELLED`.

## 10. Recovery and Stale Locks

If a worker accepts a job and crashes before terminal output, status can remain `ACCEPTED` and `execution.lock/` can remain in the job store.

Detect stale state:

```bash
node bin/git-runner.js status <job-id> --stale-after-sec 300
```

Inspect recovery preconditions:

```bash
node bin/git-runner.js recover-lock <job-id> --stale-after-sec 300
```

`recover-lock` is read-only. `eligible: true` is not permission to delete the lock. It means a human can begin review: confirm the worker process is stopped, preserve lock metadata for audit, and then decide whether manual recovery is appropriate.

## 11. Exit Codes and Failures

Common outcomes:

- invalid CLI usage returns exit code `2`;
- Git failures return exit code `3`;
- NATS or worker dispatch failures return exit code `4`;
- job store read/write failures return exit code `5`;
- `local run` returns non-zero when the Result Bundle status is failed or cancelled.

For the full matrix, see [specs/error-catalog.md](specs/error-catalog.md).

## 12. Development

Fast syntax check:

```bash
npm run check
```

Fast NATS-free tests:

```bash
npm run test:local
```

Full test suite:

```bash
npm test
```

Use `npm test` before pushing or when changing submit, worker, NATS, JetStream, or recovery behavior.

## 13. Reference Documents

- [PRD](prd.md)
- [Architecture spec](specs/architecture.md)
- [CLI spec](specs/cli.md)
- [Config spec](specs/config.md)
- [Job Spec](specs/job-spec.md)
- [Worker spec](specs/worker.md)
- [Result Bundle spec](specs/result-bundle.md)
- [Recovery spec](specs/recovery.md)
- [Error catalog](specs/error-catalog.md)
- [ADR index](adr/README.md)
