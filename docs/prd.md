# git-runner PRD

## 1. 概要

`git-runner` は、Git 管理された任意プロジェクトの特定 commit を worker 側で checkout し、指定された command を実行し、stdout / stderr / exit code / result / artifacts を回収する分散 runner である。

Research Booster から見ると、`git-runner` は実験実行基盤である。実験の意味づけ、Finding、Recommendation、知見管理は Research Booster 側の責務であり、`git-runner` は Git checkout、command execution、logs/result/artifacts collection に責務を限定する。

## 2. 目的

- 任意の Git repository と commit に対して再現可能な command execution を提供する。
- submitter と worker を NATS 経由で疎結合にする。
- worker が任意 command を実行できるようにしつつ、最低限の認証、routing、policy、timeout、workspace isolation を持たせる。
- Research Booster などの上位システムが、実験実行だけを外部 runner に委譲できるようにする。

## 3. ユーザーの困りごと

### 3.1 実験実行者

実験実行者は、手元または CI で実験 command を実行できるが、実験対象 code が branch 名だけで指定されていると、submit 後に branch が進んだとき同じ実験を再現できない。必要なのは、branch ではなく submit 時点の commit SHA に固定された実行である。

### 3.2 Research Booster

Research Booster は実験計画、Run、Finding、Recommendation を管理したいが、任意 repository の checkout、worker routing、command execution、logs/result/artifacts collection まで持つと責務が大きくなる。必要なのは、実験の意味づけを持たない汎用実行基盤である。

### 3.3 Worker 運用者

Worker 運用者は GPU、high-memory、private repository など特性の異なる worker に job を振り分けたい。一方で worker は任意 command を実行するため、許可していない repository や tag の job を受け取ると危険である。必要なのは、worker tags、allowed repositories、allowed tags、timeout、workspace cleanup による最低限の制御である。

### 3.4 実装者

実装者は submit、worker、executor、status/log/result retrieval を分けて実装する必要がある。境界が曖昧だと、worker 本体が command crash に巻き込まれたり、branch checkout によって再現性が崩れたり、result validation failure の扱いが揺れる。必要なのは、一意に実装できる Job Spec、status/reason catalog、executor contract、storage contract である。

## 4. 非目的

- 実験結果の意味を解釈しない。
- Research Booster 固有の schema や知識を内包しない。
- NATS server を同梱、起動、管理しない。
- MVP では Docker / Kubernetes runtime を提供しない。
- MVP では web dashboard、PR 作成、本格 artifact store、command allowlist を提供しない。
- 実行対象言語を限定しない。
- MVP では multi-machine result retrieval を提供しない。submitter、worker、inspection commands は同一 host または共有 filesystem 上の `job_store_root` を参照する前提とする。

## 5. 対象ユーザー

- Research Booster から実験 job を投入するシステム。
- ローカルまたは社内 worker で任意の Git commit に対して test / eval / benchmark / experiment command を実行したい開発者。
- GPU / high-memory / private repository など worker 特性に応じて job を routing したい運用者。

## 6. 主要ユースケース

### 6.1 ローカル開発者が job を投入する

```bash
npm install -D @hachiware-labs/git-runner
git-runner submit --repo . --command "npm test"
```

期待結果:

- 現在 repository の実行対象 commit SHA が固定される。
- job spec が NATS に publish される。
- `job_id` が返る。

### 6.2 明示的に commit & push してから job を投入する

```bash
git-runner submit \
  --repo . \
  --command "pytest" \
  --commit-and-push \
  --branch codex/exp-001
```

期待結果:

- `--commit-and-push` が明示された場合のみ commit / push する。
- 実行対象 commit SHA を固定して job spec に含める。
- branch は provenance と routing に必要な情報として保持してよいが、実行正本ではない。

### 6.3 worker が job を実行する

```bash
git-runner worker \
  --nats-url nats://localhost:4222 \
  --worker-id local-001 \
  --worker-key $GIT_RUNNER_WORKER_KEY
```

期待結果:

- worker key が指定されていることを検証する。
- worker tags / allowed repositories / allowed tags に合う job だけを受け取る。
- repository を clone/fetch し、指定 commit を detached HEAD で checkout する。
- params を `.git-runner/params.json` に書き出す。
- executor process で command を実行する。
- stdout / stderr / exit_code / signal / duration / result / artifacts を保存・返却する。
- executor が失敗しても worker supervisor は停止しない。

### 6.4 job の状態と結果を見る

```bash
git-runner status <job-id>
git-runner logs <job-id>
git-runner get <job-id>
```

期待結果:

- job status、reason、duration、worker id などが確認できる。
- stdout / stderr の保存済みログを確認できる。
- result JSON と artifacts metadata を取得できる。

## 7. MVP スコープ

MVP で実装するもの:

- npm package
- `git-runner` bin
- `git-runner init`
- `git-runner submit`
- `git-runner worker`
- `git-runner status`
- `git-runner logs`
- `git-runner get`
- Git repository inspection
- commit SHA 固定
- branch 指定時の commit 解決
- `commit` 指定時の branch より優先
- worker の clone/fetch/checkout
- detached HEAD execution
- command execution
- worker supervisor / executor process separation
- params JSON file
- stdout / stderr / exit_code / signal / duration
- optional result JSON parse / JSON Schema validation
- worker key
- worker id
- worker tags
- allowed repositories
- allowed tags
- timeout
- max stdout/stderr bytes
- local filesystem based logs/result/artifacts storage
- NATS_URL 接続
- single-host or shared-filesystem result retrieval

MVP で後回しにするもの:

- Docker runtime
- Kubernetes
- multi-job concurrency per worker
- NATS server bootstrap
- NATS cluster management
- production artifact object store
- command allowlist
- Research Booster builtin schema
- web dashboard
- PR 作成
- multi-machine result retrieval without shared storage

## 8. 成功条件

- submitter が Git commit SHA を固定した job spec を NATS に publish できる。
- worker が NATS から job を受け取り、指定 commit を detached checkout して command を実行できる。
- command が成功した場合、job が `COMPLETED` になり、stdout / stderr / exit_code / duration / optional result が取得できる。
- command が失敗、timeout、result invalid、git checkout failed の場合、job が `FAILED` になり、`reason` で失敗理由を確認できる。
- executor process が異常終了しても worker supervisor は次の job を処理できる。
- `commit` と `branch` が両方指定された場合、実行対象は `commit` になる。
- `--commit-and-push` なしでは repository に commit / push しない。
- status / logs / get が local job store から terminal job 情報を取得できる。
- validation、policy、git、command、timeout、result、cancel の失敗が定義済み reason に分類される。

## 9. 利用者体験

グローバルインストール:

```bash
npm install -g @hachiware-labs/git-runner
git-runner init
git-runner submit --command "pytest"
git-runner worker
```

プロジェクトローカルインストール:

```bash
npm install -D @hachiware-labs/git-runner
git-runner submit --command "npm test"
```

`npx` は試用手段として許可するが、正式なユーザー体験は `git-runner` コマンドを直接使う形とする。

## 10. 前提

- NATS server は外部で起動されている。
- worker は信頼できる環境で運用される。
- worker は任意 command を実行できるため、worker key と policy による最低限の制御を必須とする。
- 実行対象 repository は worker が clone/fetch できる。
- MVP の runtime は host runtime とする。
- MVP の `status` / `logs` / `get` は worker が書き込んだ `job_store_root` を参照できる環境で使う。
