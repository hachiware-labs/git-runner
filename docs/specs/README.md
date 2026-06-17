# git-runner specs

このディレクトリは `git-runner` の実装仕様を定義する。

## 仕様一覧

- [architecture.md](architecture.md): 全体アーキテクチャ、レイヤー、責務境界、データフロー
- [cli.md](cli.md): CLI command と option
- [config.md](config.md): project config と worker config
- [git.md](git.md): Git repository inspection、ref resolution、checkout
- [job-spec.md](job-spec.md): Job Spec JSON contract
- [worker.md](worker.md): worker config、workspace、supervisor/executor
- [status-events.md](status-events.md): job status、reason、NATS subjects、events
- [error-catalog.md](error-catalog.md): エラー条件、reason、発生箇所、retry 可否、CLI exit code
- [result-artifacts.md](result-artifacts.md): stdout/stderr/result/artifacts の保存と取得
- [security-policy.md](security-policy.md): worker key、allowed tags/repositories、実行 policy
- [recovery.md](recovery.md): stale execution lock の診断と手動復旧手順

## 実装ルール

- specs は実装の正本である。
- 仕様変更が必要な場合は、実装前または同じ変更で specs を更新する。
- ADR と衝突する場合は ADR を更新してから specs を変更する。
