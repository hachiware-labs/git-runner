# ADR 0001: Use NATS for queue and event transport

## Status

Accepted

## Context

`git-runner` は submitter と worker を分離し、job queue、worker coordination、status event、logs/result transport を扱う必要がある。MVP では単一 NATS server を前提にし、NATS server の導入・起動・運用は `git-runner` の責務外とする。

worker は tags に応じて job を受け取りたい。例えば CPU worker、GPU worker、large VRAM worker、trusted private repo worker などを routing できる必要がある。

## Decision

NATS を job queue / status event / worker coordination の transport として使う。

MVP の subject は routing tag ごとに分ける。

```text
git-runner.jobs.default
git-runner.jobs.gpu-small
git-runner.jobs.gpu-large
git-runner.jobs.high-memory
git-runner.status.<job-id>
git-runner.logs.<job-id>
```

MVP では `worker.tags[0]` を routing tag として使い、job は単一 routing tag に publish する。

NATS server は同梱しない。利用者は `GIT_RUNNER_NATS_URL` または CLI option で接続先を指定する。

## Consequences

- submitter と worker を疎結合にできる。
- routing tag による worker 選択を実装しやすい。
- NATS server がない環境では integration / e2e test は実行できない。
- NATS の永続化、JetStream、Object Store の採用範囲は specs で段階的に定義する必要がある。

## Alternatives Considered

### Direct HTTP API

HTTP server を `git-runner` 側に持つ必要があり、worker coordination と queue semantics を別途実装する必要があるため MVP では採用しない。

### Local filesystem queue

ローカル開発では簡単だが、分散 worker の要件を満たしにくいため採用しない。

### Redis queue

queue としては有効だが、NATS の軽量な pub/sub、subject routing、worker coordination との相性を優先する。
