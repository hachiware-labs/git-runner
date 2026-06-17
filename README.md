# git-runner

`git-runner` is a Git commit pinned command runner. The MVP target is to submit a Job Spec over NATS, run it on a worker, and collect status, logs, result, and artifacts.

Current implementation status:

- implemented: npm package entrypoint
- implemented: `git-runner init`
- implemented: `git-runner status <job-id>` against local job store
- implemented: `git-runner logs <job-id>` against local job store
- implemented: `git-runner get <job-id>` against local job store
- not yet implemented: `submit`
- not yet implemented: `worker`
- not yet implemented: NATS publish/subscribe
- not yet implemented: executor process

## Quick Start

Run the CLI directly from this checkout:

```bash
node bin/git-runner.js init
```

This creates:

```text
.git-runner/config.json
```

Run checks:

```bash
npm run check
npm test
```

## Local Job Store

Inspection commands read from:

```text
.git-runner/jobs/<job-id>/
  status.json
  stdout.log
  stderr.log
  result-summary.json
```

Examples:

```bash
node bin/git-runner.js status job_001
node bin/git-runner.js logs job_001
node bin/git-runner.js get job_001 --json
```

## Docs

- [Document index](docs/README.md)
- [PRD](docs/prd.md)
- [Architecture spec](docs/specs/architecture.md)
- [Error catalog](docs/specs/error-catalog.md)
- [CLI spec](docs/specs/cli.md)
