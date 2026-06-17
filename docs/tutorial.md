# git-runner Tutorial

This tutorial runs a complete local `git-runner` flow:

1. start NATS
2. initialize config
3. preview a pinned Job Spec
4. start a worker
5. submit a job
6. inspect status, logs, result, and artifacts

The commands use `node bin/git-runner.js` so they work directly from this repository checkout.

## 1. Prepare

Install dependencies:

```bash
npm install
```

Check the CLI:

```bash
node bin/git-runner.js --help
```

Confirm the repository has at least one commit:

```bash
git rev-parse --verify HEAD
```

## 2. Start NATS

Start a local NATS server in a separate terminal:

```bash
nats-server
```

Keep that terminal running while you submit and process jobs.

If your NATS server listens somewhere else, pass `--nats-url` to both `submit` and `worker`, or set `GIT_RUNNER_NATS_URL`.

Important: the MVP uses NATS core request/reply for default job dispatch, not a durable queue. By default, `submit` requires a matching worker to accept the job message before returning. If no worker accepts it, submit fails and does not leave a pending job.

If a worker accepts a job and then crashes before validation or execution, `status <job-id>` may remain `ACCEPTED`. In the MVP this is diagnostic only; automatic retry is not performed.

To flag an accepted job as stale after 30 seconds:

```bash
node bin/git-runner.js status <job-id> --stale-after-sec 30
```

## 3. Initialize git-runner Config

Create the default config:

```bash
node bin/git-runner.js init
```

This creates:

```text
.git-runner/config.json
```

The generated config includes:

- `nats_url`
- default worker tags
- result path
- artifact list
- timeout and log size limits
- local job store path

## 4. Preview the Job Spec

Dry-run submit does not publish to NATS and does not write a job store entry.

```bash
node bin/git-runner.js submit --repo . --command "npm test" --dry-run --json
```

Inspect these fields in the output:

- `job_spec.source.commit`: the commit SHA that the worker will execute
- `job_spec.source.branch`: provenance only, when present
- `job_spec.entry.command`: the command to run
- `subject`: the NATS subject

If you pass both `--commit` and `--branch`, `--commit` wins.

```bash
node bin/git-runner.js submit --repo . --branch <branch-name> --commit <commit-sha> --command "npm test" --dry-run --json
```

## 5. Start a Worker

Run a one-job worker in another terminal and leave it waiting:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

For a stricter local worker, allow only the current repository path:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-repo C:\path\to\git-runner --once
```

The worker subscribes to `git-runner.jobs.default`. Keep this process running before the next step.

## 6. Submit a Job

Submit the current committed state:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

Copy the printed `job_id`. The waiting worker should receive the message, process one job, and exit.

If the working tree is dirty, `submit` still uses the committed Git state and prints a warning. To include local changes, commit them yourself or use `--commit-and-push`.

```bash
node bin/git-runner.js submit --repo . --command "npm test" --branch codex/tutorial-run --commit-and-push --message "Prepare tutorial run"
```

Use `--commit-and-push` only when you really want the CLI to stage all changes, commit them if needed, and push the selected branch.

To bypass the dispatch guard, pass `--no-require-worker`:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --no-require-worker
```

With the guard disabled, `submit` uses publish-only delivery and NATS core will not retain the job for a worker that subscribes later.

The worker will:

1. receive the job from NATS
2. validate worker policy
3. prepare a workspace under `.git-runner/workspaces`
4. clone/fetch the repository
5. checkout `source.commit` as detached `HEAD`
6. run the command
7. store logs and result summary
8. publish terminal status and result events

## 7. Inspect the Job

Read latest status:

```bash
node bin/git-runner.js status <job-id>
```

Read logs:

```bash
node bin/git-runner.js logs <job-id>
node bin/git-runner.js logs <job-id> --stdout
node bin/git-runner.js logs <job-id> --stderr
```

Read result summary:

```bash
node bin/git-runner.js get <job-id>
node bin/git-runner.js get <job-id> --json
```

The local job store is:

```text
.git-runner/jobs/<job-id>/
  status.json
  stdout.log
  stderr.log
  result-summary.json
  artifacts/
```

## 8. Add Result JSON

By default, result JSON is optional and expected at:

```text
.git-runner/result.json
```

For example, submit a command that writes a result:

```bash
node bin/git-runner.js submit --repo . --command "node -e \"require('fs').mkdirSync('.git-runner',{recursive:true}); require('fs').writeFileSync('.git-runner/result.json', JSON.stringify({ ok: true }))\""
```

Run the worker, then inspect:

```bash
node bin/git-runner.js get <job-id> --json
```

## 9. Require a JSON Schema Result

Create a schema file in the repository:

```json
{
  "type": "object",
  "required": ["ok"],
  "properties": {
    "ok": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

Save it as:

```text
schemas/result.schema.json
```

Commit the schema, then submit with `--result-schema`:

```bash
node bin/git-runner.js submit --repo . --command "node -e \"require('fs').mkdirSync('.git-runner',{recursive:true}); require('fs').writeFileSync('.git-runner/result.json', JSON.stringify({ ok: true }))\"" --result-schema schemas/result.schema.json
```

If the file is missing or invalid, the job fails with `result_missing` or `result_invalid`.

## 10. Collect Artifacts

Artifact collection is configured in `.git-runner/config.json`.

Example:

```json
{
  "schema_version": 1,
  "outputs": {
    "result": {
      "path": ".git-runner/result.json",
      "schema": { "type": "none" }
    },
    "artifacts": [
      {
        "name": "report",
        "path": "results/report.md",
        "kind": "markdown",
        "media_type": "text/markdown"
      }
    ]
  }
}
```

Submit a command that creates the artifact:

```bash
node bin/git-runner.js submit --repo . --command "node -e \"require('fs').mkdirSync('results',{recursive:true}); require('fs').writeFileSync('results/report.md', '# Report\\n')\""
```

After the worker finishes, copy collected artifacts to an output directory:

```bash
node bin/git-runner.js get <job-id> --output out
```

## Troubleshooting

`worker key missing`

: Pass `--worker-key <key>` or set `GIT_RUNNER_WORKER_KEY`.

`worker_policy_denied`

: Use `--allow-all-repos` for local development, or pass the exact repository path with `--allow-repo`.

`NATS connect failed`

: Start `nats-server`, or pass the correct `--nats-url` to both submit and worker.

`command_failed`

: Inspect `logs <job-id>` and `get <job-id> --json` for exit code and stderr.

`timeout`

: Increase `--timeout-sec`, or shorten the command.

`result_missing` or `result_invalid`

: Check the result path and JSON Schema. With `--result-schema`, the result file is required.
