# git-runner

`git-runner` は、Git の特定 commit に固定して worker 側で command を実行し、job status、logs、result JSON、artifacts を local job store に保存する runner です。

MVP の責務は意図的に狭くしています。

- Git repository に基づく job を NATS に submit する
- branch は submit 時点で commit SHA に解決する
- worker は固定された commit だけを実行する
- stdout、stderr、exit status、任意の result JSON、artifacts を回収する
- 実験の意味づけ、Finding、Recommendation は runner の外に置く

English documentation is available in [README.md](README.md).

## なぜ作るか

branch 名は動きます。`git-runner` は実行対象を commit SHA に固定することで、実験、benchmark、test run を後から再現できるようにします。branch は provenance として残せますが、worker は branch を再解決して実行対象を決めません。

## 現在の実装状況

実装済みの MVP 機能:

- `git-runner init`
- `git-runner submit`
- `git-runner submit --dry-run`
- `git-runner submit --commit-and-push`
- `git-runner submit --jetstream`
- `git-runner worker --once`
- NATS への job publish と worker subscribe
- JetStream による任意の durable job delivery
- `source.commit` の detached checkout
- worker tag / repository policy
- timeout と cancellation
- stdout/stderr capture と truncation metadata
- 任意の result JSON と JSON Schema validation
- artifact collection
- local `status`、`logs`、`get`
- read-only `recover-lock` stale lock inspection

MVP の対象外:

- web dashboard
- production artifact object storage
- 共有 filesystem なしの multi-machine result retrieval
- command allowlist
- container runtime isolation
- local worker key を超える authenticated worker protocol

## 必要なもの

- Node.js 22 以上
- Git
- dry-run 以外の submit/worker flow では NATS server
- `--jetstream` を使う場合は JetStream 有効の NATS server

この checkout で依存関係を入れます。

```bash
npm install
```

CLI を直接実行します。

```bash
node bin/git-runner.js --help
```

ローカルに link して `git-runner` として呼ぶこともできます。

```bash
npm link
git-runner --help
```

## Quick Start

別 terminal で NATS を起動します。

```bash
nats-server
```

さらに別 terminal で、1 job だけ処理する worker を起動して待機させます。

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

project config を作成します。

```bash
node bin/git-runner.js init
```

job を投入します。

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

出力された `job_id` を控えます。待機中の worker が job を処理して終了します。

job を確認します。

```bash
node bin/git-runner.js status <job-id>
node bin/git-runner.js logs <job-id>
node bin/git-runner.js get <job-id> --json
```

通しの手順は [docs/tutorial_ja.md](docs/tutorial_ja.md) を参照してください。

重要: MVP の default job dispatch は NATS core request/reply を使っており、durable queue ではありません。default では、`submit` は一致する worker が job message を accept したことを確認してから戻ります。worker が accept しない場合、pending job を残さずに失敗します。この guard を意図的に外す場合だけ `--no-require-worker` を使います。

durable な local delivery が必要な場合は、NATS を JetStream 有効で起動し、submit と worker の両方に `--jetstream` を渡します。

```bash
nats-server -js
node bin/git-runner.js submit --repo . --command "npm test" --jetstream
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --jetstream --once
```

JetStream mode では、`submit` は job を stream `GIT_RUNNER_JOBS` に保存します。一致する worker は submit 後に起動しても job を受け取れます。delivery は at-least-once です。同じ `job_store_root` を共有する worker は local job store の execution lock で重複実行を避けますが、worker が terminal result を書く前に crash した場合に備えて、command は再実行されてもよい形にする必要があります。

worker が job を accept した後、validation や execution の前に crash した場合、latest status が `ACCEPTED` のまま残ることがあります。これは job が worker に届いたが、terminal result は記録されていない状態を意味します。

`status --stale-after-sec <seconds>` で、一定時間進んでいない `ACCEPTED` job や `execution.lock` を検出できます。これは診断用で、MVP は stale job の自動 retry や stale lock の自動解放は行いません。
stale lock の手動復旧ルールは [docs/specs/recovery.md](docs/specs/recovery.md) を参照してください。

job store を変更せずに stale lock 復旧の前提条件を確認できます。

```bash
node bin/git-runner.js recover-lock <job-id> --stale-after-sec 300
```

## よく使う command

default config を作成:

```bash
node bin/git-runner.js init
```

publish せず Job Spec を確認:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --dry-run --json
```

現在の committed state を submit:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

実行されるには、対象 NATS subject を購読している worker が先に起動している必要があります。

worker dispatch guard を bypass:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --no-require-worker
```

guard を外すと、`submit` は publish-only delivery を使います。NATS core は後から subscribe した worker のために job を保持しません。

JetStream durable delivery を使う:

```bash
nats-server -js
node bin/git-runner.js submit --repo . --command "npm test" --jetstream
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --jetstream --once
```

submit 前に commit / push する:

```bash
node bin/git-runner.js submit --repo . --command "npm test" --branch codex/exp-001 --commit-and-push --message "Prepare experiment"
```

明示した repository だけを受け付ける worker:

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-repo C:\path\to\repo --once
```

## Job Store

MVP では job data を以下に保存します。

```text
.git-runner/jobs/<job-id>/
  status.json
  stdout.log
  stderr.log
  result-summary.json
  execution.lock/
  artifacts/
```

`status`、`logs`、`get` はこの local store を読みます。MVP では submitter、worker、inspection commands が同一 host または共有 filesystem を使う前提です。
`execution.lock/` は内部用で、worker が job execution を所有している間だけ存在します。

## Git の原則

- `--commit` は `--branch` より優先されます。
- `--commit` がない場合、`--branch` は submit 時点で commit SHA に解決されます。
- 両方ない場合、現在の `HEAD` を使います。
- worker は `source.commit` を detached `HEAD` で checkout します。
- `submit` は `--commit-and-push` がない限り commit / push しません。
- dirty working tree の変更は、先に commit しない限り job に入りません。

## 開発

確認 command:

```bash
npm run check
npm test
```

test suite には local CLI tests と、local NATS server binary が利用できる場合の NATS integration tests が含まれます。

## Documentation

- [English README](README.md)
- [English tutorial](docs/tutorial.md)
- [日本語 tutorial](docs/tutorial_ja.md)
- [Document index](docs/README.md)
- [PRD](docs/prd.md)
- [Architecture spec](docs/specs/architecture.md)
- [CLI spec](docs/specs/cli.md)
- [Error catalog](docs/specs/error-catalog.md)
- [Local run spec](docs/specs/local-run.md)
- [Result Bundle spec](docs/specs/result-bundle.md)
- [ADR index](docs/adr/README.md)
