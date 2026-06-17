# ADR 0006: Use local filesystem job store for MVP

## Status

Accepted

## Context

worker must preserve stdout, stderr, result summary, job status, and artifact metadata. The requirements allow MVP to choose one artifact/result storage approach among local filesystem, NATS object store, or simple HTTP upload.

The first implementation should prioritize a complete vertical slice over distributed storage complexity.

## Decision

MVP uses a local filesystem job store.

Default path:

```text
.git-runner/jobs/<job-id>/
```

Required files:

```text
job-spec.json
status.json
stdout.log
stderr.log
result-summary.json
artifacts/
```

NATS is still used for job transport and status/log/result events. CLI commands such as `status`, `logs`, and `get` read from the local job store.

MVP supports single-host or shared-filesystem development where submitter, worker, and inspection commands can access the same `job_store_root`. Multi-machine result retrieval without shared storage is out of scope for MVP and will require a future storage provider or event mirroring implementation.

## Consequences

- MVP can implement end-to-end behavior without NATS Object Store or HTTP upload.
- Local development is straightforward.
- Multi-machine operation requires shared storage for MVP.
- A future storage provider abstraction will be needed for production artifact handling.

## Alternatives Considered

### NATS Object Store

Attractive for NATS-centric deployments, but adds JetStream/Object Store requirements to the first implementation.

### HTTP upload

Simple in some environments, but introduces another service and authentication surface.
