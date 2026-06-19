# git-runner 詳細マニュアル

このマニュアルは、`git-runner` の setup、job 実行、確認、Result Bundle export、復旧診断、開発時の検証までをまとめます。

最初の通し実行だけを確認したい場合は [tutorial_ja.md](tutorial_ja.md) を参照してください。実装契約の正本は [specs/](specs/) です。

## 1. git-runner が行うこと

`git-runner` は、Git の特定 commit に固定して worker 側で command を実行します。job state、stdout、stderr、result JSON、artifacts は local job store に保存します。

最重要ルールは、実行対象を commit SHA に固定することです。

- `--commit` は `--branch` より優先されます。
- `--commit` がなく `--branch` がある場合、submit 時点で branch を commit SHA に解決します。
- 両方ない場合、現在の `HEAD` を使います。
- worker は `source.commit` を detached `HEAD` で checkout します。

default の job delivery は NATS JetStream です。worker がまだ起動していなくても、`submit` は durable な pending job を保存できます。

## 2. 必要なもの

- Node.js 22 以上
- Git
- NATS server
- 通常の submit/worker flow では JetStream 有効の NATS

依存関係を入れます。

```bash
npm install
```

checkout から CLI を直接実行します。

```bash
node bin/git-runner.js --help
```

必要なら local link します。

```bash
npm link
git-runner --help
```

## 3. 設定

project config を作成します。

```bash
node bin/git-runner.js init
```

default path:

```text
.git-runner/config.json
```

重要な project config fields:

- `nats_url`: NATS server URL。
- `delivery_mode`: default は `jetstream`。
- `default_worker_tags`: `--worker-tags` 省略時の routing tags。
- `param_passing`: executor が job params を書く場所。
- `outputs.result`: result JSON path と任意の schema。
- `outputs.artifacts`: 回収する files / directories。
- `execution`: timeout と log byte limits。
- `job_store_root`: local job store root。

worker config は `.git-runner/worker.json` で指定できますが、local development では CLI options で渡すことが多いです。

worker key は `init` では保存しません。`--worker-key` または `GIT_RUNNER_WORKER_KEY` で渡してください。

## 4. NATS と delivery mode

JetStream 有効で NATS を起動します。

```bash
nats-server -js
```

default delivery:

```bash
node bin/git-runner.js submit --repo . --command "npm test"
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

JetStream delivery は job を stream `GIT_RUNNER_JOBS` に保存します。delivery は at-least-once です。worker が terminal result を書く前に crash すると再配送される可能性があるため、job command は再実行されてもよい形にしてください。同じ `job_store_root` を共有する worker では、local job store の execution lock が重複実行を防ぎます。

legacy core delivery も利用できます。

```bash
node bin/git-runner.js submit --repo . --command "npm test" --delivery-mode core
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --delivery-mode core --once
```

core delivery では、`submit` が戻る前に matching worker が job を accept する必要があります。`--no-require-worker` は core delivery のみで有効です。

```bash
node bin/git-runner.js submit --repo . --command "npm test" --delivery-mode core --no-require-worker
```

## 5. job を submit する

job store への書き込みや NATS publish をせずに Job Spec を確認します。

```bash
node bin/git-runner.js submit --repo . --command "npm test" --dry-run --json
```

現在の `HEAD` を submit します。

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

branch を submit 時点で一度だけ解決して submit します。

```bash
node bin/git-runner.js submit --repo . --branch main --command "npm test"
```

明示 commit を submit します。

```bash
node bin/git-runner.js submit --repo . --commit <sha> --command "npm test"
```

submit 前に commit / push します。

```bash
node bin/git-runner.js submit --repo . --branch codex/exp-001 --commit-and-push --message "Prepare experiment" --command "npm test"
```

`--commit-and-push` を使わず working tree が dirty な場合、`submit` は warning を出します。dirty changes は先に commit しない限り job には入りません。

## 6. worker を起動する

1 job だけ処理して終了します。

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

特定 repository だけを受け付けます。

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-repo C:\path\to\repo --once
```

routing tag を使います。

```bash
node bin/git-runner.js submit --repo . --worker-tags gpu --command "npm test"
node bin/git-runner.js worker --worker-id gpu-001 --worker-key dev --tags gpu --allow-all-repos --once
```

worker は以下を検証します。

- worker key があること
- allowed tags
- allowed repositories
- Job Spec の形
- configured result schema

## 7. job を確認する

latest status:

```bash
node bin/git-runner.js status <job-id>
```

logs:

```bash
node bin/git-runner.js logs <job-id>
node bin/git-runner.js logs <job-id> --stderr
```

terminal result summary:

```bash
node bin/git-runner.js get <job-id> --json
```

job store layout:

```text
.git-runner/jobs/<job-id>/
  status.json
  stdout.log
  stderr.log
  result-summary.json
  execution.lock/
  artifacts/
```

MVP では submitter、worker、inspection commands が同一 host または共有 filesystem を使う前提です。

## 8. Result JSON、artifacts、bundle

command は configured `outputs.result.path` に result JSON を書けます。JSON Schema が設定されている場合、worker は command 終了後に result を検証します。

Artifacts は named output paths として設定し、実行後に job store へ copy します。

terminal worker result を Result Bundle として export します。

```bash
node bin/git-runner.js get <job-id> --bundle
```

Result Bundle を検証します。

```bash
node bin/git-runner.js validate-bundle .git-runner/jobs/<job-id>/result-bundle.json
```

Bundle は Web UI に載せられる軽量サイズを前提にしています。logs と artifacts は metadata として扱い、大きな file 本文は埋め込みません。Result JSON は inline budget に収まる場合だけ bundle に埋め込み、超過する場合は warning を出して省略します。

## 9. local run

`local run` は、NATS、worker auth、execution lock、Git checkout を使わず、既存 workspace で Job Spec を実行します。contract validation を高速に行うための command です。

```bash
node bin/git-runner.js local run job.json --workspace . --bundle .git-runner/result-bundle.json --json
```

`local run` は `git-runner.result-bundle.v1` Result Bundle を書きます。bundle status が `FAILED` または `CANCELLED` の場合、exit code は non-zero です。

## 10. recovery と stale lock

worker が job を accept した後、terminal output を書く前に crash すると、status が `ACCEPTED` のまま残り、`execution.lock/` が job store に残ることがあります。

stale state を検出します。

```bash
node bin/git-runner.js status <job-id> --stale-after-sec 300
```

復旧前提を確認します。

```bash
node bin/git-runner.js recover-lock <job-id> --stale-after-sec 300
```

`recover-lock` は read-only です。`eligible: true` は lock を削除してよいという意味ではありません。人間が review を始める条件です。worker process が停止していることを確認し、lock metadata を audit 用に保存したうえで、手動復旧するか判断してください。

## 11. exit code と failure

代表的な outcome:

- invalid CLI usage は exit code `2`
- Git failure は exit code `3`
- NATS / worker dispatch failure は exit code `4`
- job store read/write failure は exit code `5`
- `local run` は Result Bundle status が failed / cancelled の場合 non-zero

完全な一覧は [specs/error-catalog.md](specs/error-catalog.md) を参照してください。

## 12. 開発時の確認

構文確認:

```bash
npm run check
```

NATS なしの高速テスト:

```bash
npm run test:local
```

full test suite:

```bash
npm test
```

submit、worker、NATS、JetStream、recovery 周辺を変更した場合、push 前に `npm test` を実行してください。

## 13. 参照文書

- [PRD](prd.md)
- [Architecture spec](specs/architecture.md)
- [CLI spec](specs/cli.md)
- [Config spec](specs/config.md)
- [Job Spec](specs/job-spec.md)
- [Worker spec](specs/worker.md)
- [Result Bundle spec](specs/result-bundle.md)
- [Recovery spec](specs/recovery.md)
- [Error catalog](specs/error-catalog.md)
- [ADR index](adr/README.md)
