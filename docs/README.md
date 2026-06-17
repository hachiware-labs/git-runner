# git-runner documents

このディレクトリは `git-runner` のプロダクト要件、設計判断、実装仕様を管理する。

## 文書構成

- [git-runner-requirements.md](git-runner-requirements.md): 初期の要件メモ。背景と要求の原文として残す。
- [prd.md](prd.md): Product Requirements Document。何を作るか、誰のためのものか、MVP の境界を定義する。
- [tutorial.md](tutorial.md): English tutorial。local NATS で submit、worker、inspection を通す。
- [tutorial_ja.md](tutorial_ja.md): 日本語 tutorial。local NATS で submit、worker、inspection を通す。
- [adr/](adr/): Architecture Decision Record。重要な設計判断と理由を記録する。
- [specs/](specs/): 実装仕様。CLI、Job Spec、worker、status、result、security などの契約を定義する。

## 実装時の優先順位

仕様が衝突した場合は、原則として以下の順で正本とする。

1. `docs/specs/`
2. `docs/adr/`
3. `docs/prd.md`
4. `docs/git-runner-requirements.md`

ただし、要件メモだけに存在する未反映の要求が見つかった場合は、先に該当する PRD / ADR / specs を更新してから実装する。

## 最重要原則

- 実行対象の正本は branch ではなく commit SHA とする。
- `commit` と `branch` が両方指定された場合は `commit` を優先する。
- `branch` は `commit` 未指定時に submit 時点で commit SHA に解決する。
- worker は branch を再解決せず、指定 commit を detached HEAD で checkout する。
- `--commit-and-push` なしに勝手に commit / push しない。
- worker supervisor と executor process は分離する。
- durable job delivery が必要な場合は JetStream mode を明示的に選ぶ。
