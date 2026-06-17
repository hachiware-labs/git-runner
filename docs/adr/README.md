# Architecture Decision Records

このディレクトリは `git-runner` の重要な設計判断を記録する。

## ADR 一覧

- [0001 Use NATS for queue and event transport](0001-use-nats-for-queue-and-event-transport.md)
- [0002 Pin execution to commit SHA](0002-pin-execution-to-commit-sha.md)
- [0003 Separate worker supervisor and executor process](0003-separate-worker-supervisor-and-executor-process.md)
- [0004 Use host runtime for MVP](0004-use-host-runtime-for-mvp.md)
- [0005 Keep Research Booster semantics outside git-runner](0005-keep-research-booster-semantics-outside-git-runner.md)
- [0006 Use local filesystem job store for MVP](0006-use-local-filesystem-job-store-for-mvp.md)
- [0007 Add JetStream job delivery mode](0007-add-jetstream-job-delivery-mode.md)

## ADR フォーマット

- Status
- Context
- Decision
- Consequences
- Alternatives Considered
