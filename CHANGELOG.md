# Changelog

## 0.1.0 - 2026-06-22

Initial MVP release candidate for local and small-team Git job execution.

### Added

- Git-backed job submission pinned to a commit SHA.
- NATS JetStream durable job delivery as the default submit/worker path.
- Worker execution with detached checkout, repository/tag policy checks, timeout handling, cancellation, stdout/stderr capture, result JSON, and artifact collection.
- Local job store commands: `status`, `logs`, and `get`.
- Result Bundle export and validation for terminal worker results.
- `local run` for NATS-free Job Spec validation in an existing workspace.
- Read-only `recover-lock` diagnostics for stale `execution.lock` recovery review.
- English and Japanese README, tutorial, and detailed manual.
- PRD, specs, ADRs, error catalog, and CI/test documentation.

### Notes

- NATS JetStream is required for the default non-dry-run submit/worker flow.
- Legacy NATS core delivery remains available with `--delivery-mode core`.
- Package publishing is not configured; this version is ready for internal tagging and validation.
