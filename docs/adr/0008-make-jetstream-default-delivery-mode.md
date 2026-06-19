# ADR 0008: Make JetStream the default delivery mode

## Status

Accepted

## Context

ADR 0007 introduced JetStream as an explicit delivery mode. Subsequent work added durable delivery tests, execution locks for redelivery safety, stale lock diagnostics, recovery documentation, and local Result Bundle contract tests.

The remaining friction is that the safer durable path requires extra flags, while the default core path has different semantics: a worker must already be available, and publish-only delivery can drop jobs for later subscribers. The project now treats NATS JetStream as the baseline deployment assumption.

## Decision

Use JetStream as the default delivery mode for `submit` and `worker`.

- Project config `delivery_mode` defaults to `jetstream`.
- Worker config `delivery_mode` defaults to `jetstream`.
- `--jetstream` remains accepted as an explicit spelling of the default.
- `--delivery-mode core` selects legacy NATS core delivery for compatibility and focused tests.
- `--no-require-worker` is valid only with core delivery.

The JetStream stream and consumer contract remains the one defined in ADR 0007.

## Consequences

- The normal `submit` path leaves a durable pending job that a matching worker can consume later.
- Non-dry-run submit/worker flows require a JetStream-enabled NATS server.
- Core request/reply behavior remains available, but it is no longer the default path.
- Documentation and tests should describe core as an explicit compatibility mode rather than the primary user flow.
