# git-runner チュートリアル

このチュートリアルでは、local で `git-runner` の一連の flow を動かします。

1. NATS を起動する
2. config を初期化する
3. commit に固定された Job Spec を preview する
4. worker を起動する
5. job を submit する
6. status、logs、result、artifacts を確認する

この repository checkout から直接動かせるように、command は `node bin/git-runner.js` を使います。

## 1. 準備

依存関係を入れます。

```bash
npm install
```

CLI を確認します。

```bash
node bin/git-runner.js --help
```

repository に commit があることを確認します。

```bash
git rev-parse --verify HEAD
```

## 2. NATS を起動する

別 terminal で local NATS server を起動します。

```bash
nats-server
```

submit と worker を動かす間、この terminal は起動したままにします。

NATS server が別 URL の場合は、`submit` と `worker` の両方に `--nats-url` を渡すか、`GIT_RUNNER_NATS_URL` を設定します。

重要: default の job dispatch は NATS JetStream を使います。`submit` は job を stream `GIT_RUNNER_JOBS` に保存するため、一致する worker は submit 後に起動しても job を受け取れます。

worker が job を accept した後、validation や execution の前に crash した場合、`status <job-id>` が `ACCEPTED` のまま残ることがあります。MVP では診断用の状態で、自動 retry は行いません。

accepted job または execution lock を 30 秒で stale と判定する例:

```bash
node bin/git-runner.js status <job-id> --stale-after-sec 30
```

job store を変更せずに stale lock 復旧の前提条件を確認する例:

```bash
node bin/git-runner.js recover-lock <job-id> --stale-after-sec 300
```

`recover-lock` は dry-run 診断 command です。手動操作に進む前に `eligible`、`reason`、`next_steps` を確認してください。`eligible: true` は lock が stale で terminal result がないことを意味しますが、`execution.lock` に触る前に、記録された worker process がもう動いていないことを人間が確認する必要があります。

NATS は JetStream 有効で起動します。

```bash
nats-server -js
```

その後は通常どおり `submit` と `worker` を実行します。`--jetstream` は default を明示する指定として引き続き使えます。

## 3. git-runner config を初期化する

default config を作成します。

```bash
node bin/git-runner.js init
```

作成される file:

```text
.git-runner/config.json
```

生成される config には以下が含まれます。

- `nats_url`
- default worker tags
- result path
- artifact list
- timeout と log size limits
- local job store path

## 4. Job Spec を preview する

dry-run submit は NATS に publish せず、job store entry も書きません。

```bash
node bin/git-runner.js submit --repo . --command "npm test" --dry-run --json
```

出力では以下を確認します。

- `job_spec.source.commit`: worker が実行する commit SHA
- `job_spec.source.branch`: 存在する場合も provenance 用
- `job_spec.entry.command`: 実行 command
- `subject`: NATS subject

`--commit` と `--branch` を両方渡した場合は `--commit` が優先されます。

```bash
node bin/git-runner.js submit --repo . --branch <branch-name> --commit <commit-sha> --command "npm test" --dry-run --json
```

## 5. Worker を起動する

別 terminal で、1 job だけ処理して終了する worker を起動して待機させます。

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --once
```

local でも少し厳しくする場合は、現在の repository path だけを許可します。

```bash
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-repo C:\path\to\git-runner --once
```

worker は `git-runner.jobs.default` を subscribe します。次の step までこの process を起動したままにします。

## 6. Job を submit する

現在の committed state を submit します。

```bash
node bin/git-runner.js submit --repo . --command "npm test"
```

出力された `job_id` を控えます。待機中の worker が message を受け取り、1 job を処理して終了します。

working tree が dirty の場合でも、`submit` は committed Git state を使い、warning を出します。local changes を含めたい場合は自分で commit するか、`--commit-and-push` を使います。

```bash
node bin/git-runner.js submit --repo . --command "npm test" --branch codex/tutorial-run --commit-and-push --message "Prepare tutorial run"
```

`--commit-and-push` は、CLI に全変更の stage、必要なら commit、選択 branch の push をさせたい場合だけ使います。

dispatch guard を bypass する場合は、`--no-require-worker` を渡します。

```bash
node bin/git-runner.js submit --repo . --command "npm test" --no-require-worker
```

`--no-require-worker` は明示的な core delivery にだけ適用できます。guard を外すと、core の `submit` は publish-only delivery を使います。NATS core は後から subscribe した worker のために job を保持しません。

legacy core delivery を使う場合は、必要に応じて JetStream なしで NATS を起動し、submit と worker の両方に `--delivery-mode core` を渡します。

```bash
node bin/git-runner.js submit --repo . --command "npm test" --delivery-mode core
node bin/git-runner.js worker --worker-id local-001 --worker-key dev --allow-all-repos --delivery-mode core --once
```

delivery は at-least-once です。同じ `job_store_root` を共有する worker は execution lock で重複実行を避けますが、worker が terminal result を書く前に crash した場合、JetStream は job を再配送できます。そのため、job command は再実行されてもよい形にしてください。

worker は以下を行います。

1. NATS から job を受け取る
2. worker policy を検証する
3. `.git-runner/workspaces` 配下に workspace を準備する
4. repository を clone/fetch する
5. `source.commit` を detached `HEAD` で checkout する
6. command を実行する
7. logs と result summary を保存する
8. terminal status と result event を publish する

## 7. Job を確認する

latest status:

```bash
node bin/git-runner.js status <job-id>
```

logs:

```bash
node bin/git-runner.js logs <job-id>
node bin/git-runner.js logs <job-id> --stdout
node bin/git-runner.js logs <job-id> --stderr
```

result summary:

```bash
node bin/git-runner.js get <job-id>
node bin/git-runner.js get <job-id> --json
```

local job store:

```text
.git-runner/jobs/<job-id>/
  status.json
  stdout.log
  stderr.log
  result-summary.json
  artifacts/
```

## 8. Result JSON を追加する

default では result JSON は optional で、以下に置かれる想定です。

```text
.git-runner/result.json
```

たとえば result を書く command を submit します。

```bash
node bin/git-runner.js submit --repo . --command "node -e \"require('fs').mkdirSync('.git-runner',{recursive:true}); require('fs').writeFileSync('.git-runner/result.json', JSON.stringify({ ok: true }))\""
```

worker 実行後に確認します。

```bash
node bin/git-runner.js get <job-id> --json
```

## 9. JSON Schema result を必須にする

repository 内に schema file を作成します。

```json
{
  "type": "object",
  "required": ["ok"],
  "properties": {
    "ok": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

保存先:

```text
schemas/result.schema.json
```

schema を commit したあと、`--result-schema` を付けて submit します。

```bash
node bin/git-runner.js submit --repo . --command "node -e \"require('fs').mkdirSync('.git-runner',{recursive:true}); require('fs').writeFileSync('.git-runner/result.json', JSON.stringify({ ok: true }))\"" --result-schema schemas/result.schema.json
```

file がない場合や schema に合わない場合、job は `result_missing` または `result_invalid` で失敗します。

## 10. Artifacts を回収する

artifact collection は `.git-runner/config.json` で設定します。

例:

```json
{
  "schema_version": 1,
  "outputs": {
    "result": {
      "path": ".git-runner/result.json",
      "schema": { "type": "none" }
    },
    "artifacts": [
      {
        "name": "report",
        "path": "results/report.md",
        "kind": "markdown",
        "media_type": "text/markdown"
      }
    ]
  }
}
```

artifact を作る command を submit します。

```bash
node bin/git-runner.js submit --repo . --command "node -e \"require('fs').mkdirSync('results',{recursive:true}); require('fs').writeFileSync('results/report.md', '# Report\\n')\""
```

worker 完了後、回収済み artifacts を output directory に copy します。

```bash
node bin/git-runner.js get <job-id> --output out
```

## Troubleshooting

`worker key missing`

: `--worker-key <key>` を渡すか、`GIT_RUNNER_WORKER_KEY` を設定します。

`worker_policy_denied`

: local development では `--allow-all-repos` を使うか、正確な repository path を `--allow-repo` に渡します。

`NATS connect failed`

: `nats-server` を起動するか、submit と worker の両方に正しい `--nats-url` を渡します。

`command_failed`

: `logs <job-id>` と `get <job-id> --json` で exit code と stderr を確認します。

`timeout`

: `--timeout-sec` を増やすか、command を短くします。

`result_missing` または `result_invalid`

: result path と JSON Schema を確認します。`--result-schema` を使う場合、result file は必須です。
