# ADR 0007: Add JetStream job delivery mode

## Status

Accepted

## Context

Default NATS core dispatch is intentionally strict: `submit` sends the job with request/reply and only succeeds after a matching worker accepts the message. This avoids silently leaving a pending job when no worker is available.

That default still has a usability gap. Some local and small-team workflows want to submit work first and start matching workers later. NATS core publish/subscribe cannot retain those jobs for future subscribers, and `--no-require-worker` only bypasses the guard; it does not make delivery durable.

The project already uses NATS as transport and does not want to introduce a separate queue dependency. NATS JetStream can provide a durable stream while preserving subject-based routing.

## Decision

Add an explicit JetStream delivery mode selected by `--jetstream` on both `submit` and `worker`.

JetStream contract:

- stream name: `GIT_RUNNER_JOBS`
- stream subjects: `git-runner.jobs.*`
- retention: work queue
- storage: file
- worker consumer durable name: `git_runner_<tag>` with unsupported characters replaced by `_`
- worker consumer filter subject: `git-runner.jobs.<tag>`
- ack policy: explicit
- max ack pending: `1`

Default behavior remains NATS core request/reply. JetStream is opt-in so existing local development, tests, and deployments do not require a JetStream-enabled server unless they choose durable delivery.

The submitter publishes the same Job Spec payload to the same routing subject. In JetStream mode the publisher ensures the stream exists and publishes with `msgID` equal to `job_id`.

The worker ensures the stream and durable consumer exist, pulls matching jobs, acquires the local job store execution lock, writes `ACCEPTED`, executes the job, writes terminal status/result, and acknowledges the JetStream message after the job reaches a terminal outcome.

The local job store execution lock is part of the idempotency policy:

- only the worker that creates `.git-runner/jobs/<job-id>/execution.lock` may execute the command;
- if `result-summary.json` already has a terminal status, redelivery is skipped and acknowledged;
- if another worker holds the lock and no terminal result exists, JetStream delivery is not acknowledged, preserving future redelivery if the original worker crashes.

## Consequences

- Users can submit a job before a worker is running, then start a matching JetStream worker later.
- Delivery becomes at-least-once. A worker crash before ack can redeliver the job, so job commands should tolerate rerun.
- Duplicate delivery after terminal completion does not rerun the command when workers share the same local job store.
- The NATS server must be started with JetStream enabled, for example `nats-server -js`.
- `git-runner` still does not own NATS server lifecycle, clustering, account configuration, or stream operations beyond ensuring the required MVP stream and consumers.
- The local job store remains the source for `status`, `logs`, and `get`; JetStream is only job delivery in this ADR.

## Alternatives Considered

### Make JetStream the default

This simplifies delivery semantics, but it would require JetStream for every non-dry-run flow. Keeping core request/reply as default preserves the lightweight local setup and existing behavior.

### Keep core NATS only

This avoids new dependency surface, but leaves a high-friction workflow where a user must start workers before submit or risk dropping jobs with publish-only delivery.

### Add a filesystem queue

A filesystem queue can be useful for single-host development, but it does not fit distributed workers or existing NATS subject routing as well as JetStream.
