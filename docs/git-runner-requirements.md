# git-runner 要件メモ

## 1. 位置づけ

`git-runner` は、Git 管理された任意プロジェクトの特定 commit/ref を worker 側で取得し、指定された command を実行する分散 runner である。

Research Booster から見ると、`git-runner` は実験実行基盤であり、実験の意味づけや知見管理は持たない。

```text
Research Booster
  実験計画、Run、Finding、Recommendation を管理する

git-runner
  Git checkout + command execution + logs/result/artifacts collection

NATS
  job queue / worker coordination / status event transport
```

## 2. 基本方針

- JavaScript / TypeScript で実装する
- npm package として配布する
- コマンド名は `git-runner`
- 実行対象の言語は限定しない
- `pyoco` には依存しない
- NATS を queue / transport として使う
- NATS server の導入・起動は外部前提にする
- worker は任意 command を実行するため、worker key と実行ポリシーを持つ

## 3. ユーザー体験

グローバルインストール:

```bash
npm install -g @research-booster/git-runner
git-runner init
git-runner submit --command "pytest"
git-runner worker
```

プロジェクトローカルインストール:

```bash
npm install -D @research-booster/git-runner
git-runner submit --command "npm test"
```

`npx` は補助的な試用手段として使えてよいが、正規のユーザー体験は `git-runner` コマンドを直接使う形にする。

## 4. CLI 要件

### 4.1 init

```bash
git-runner init
```

プロジェクトに初期設定ファイルを作る。

例:

```text
.git-runner/
  config.json
```

### 4.2 submit

```bash
git-runner submit \
  --repo . \
  --command "npm test" \
  --commit-and-push \
  --branch codex/exp-001
```

役割:

```text
1. Git repository を検査する
2. 必要なら実験用 branch を作る
3. 明示指定された場合のみ commit & push する
4. 実行対象 commit SHA を固定する
5. job spec を NATS に publish する
6. job_id を返す
```

`--commit-and-push` は明示オプションにする。

勝手に commit / push しない。

### 4.3 worker

```bash
git-runner worker \
  --nats-url nats://localhost:4222 \
  --worker-id local-001 \
  --worker-key $GIT_RUNNER_WORKER_KEY
```

役割:

```text
1. NATS に接続する
2. worker key で認証する
3. job を受け取る
4. repo を clone/fetch する
5. 指定 commit を checkout する
6. params を書き出す
7. command を実行する
8. stdout/stderr/exit_code/duration を保存する
9. output schema が指定されていれば result を検証する
10. status / logs / result / artifacts を返す
```

worker の job pull / heartbeat / status 管理プロセスと、実際に command を実行するプロセスは分離する。

実行中 command がクラッシュ、ハング、メモリ過多、signal failure などを起こしても、job を pull する worker 本体は停止しない。

### 4.4 status / logs / get

```bash
git-runner status <job-id>
git-runner logs <job-id>
git-runner get <job-id>
```

job の状態、ログ、結果を確認できる。

## 5. Job Spec

最小 job spec:

```json
{
  "schema_version": 1,
  "job_id": "job_001",
  "source": {
    "type": "git",
    "repo": "git@github.com:user/project.git",
    "branch": "codex/exp-001",
    "commit": "8f3a21c"
  },
  "working_dir": ".",
  "setup": [],
  "entry": {
    "type": "command",
    "command": "npm test"
  },
  "params": {},
  "param_passing": {
    "mode": "json_file",
    "path": ".git-runner/params.json"
  },
  "outputs": {
    "result": {
      "path": ".git-runner/result.json",
      "schema": {
        "type": "none"
      }
    },
    "artifacts": []
  },
  "execution": {
    "timeout_sec": 3600,
    "max_stdout_bytes": 10485760,
    "max_stderr_bytes": 10485760
  },
  "worker": {
    "tags": ["default"]
  }
}
```

## 6. Git 要件

実行の正本は branch ではなく commit SHA。

worker 側は `git pull` ではなく、原則として以下を使う。

```bash
git fetch origin
git checkout --detach <commit-sha>
```

理由:

- branch は job submit 後に進む可能性がある
- commit SHA なら再現性を確保できる
- detached HEAD の方が worker workspace の状態が明確になる

## 7. Command 実行要件

`git-runner` は実行対象の言語を知らない。

例:

```json
{ "command": "pytest" }
```

```json
{ "command": "npm test" }
```

```json
{ "command": "cargo test --release" }
```

```json
{ "command": "bash experiments/run.sh" }
```

MVP では `entry.type: command` のみでよい。

### 7.1 実行プロセス分離

worker は以下の2層構造にする。

```text
worker supervisor
  NATS 接続
  job pull
  heartbeat
  status publish
  workspace 管理
  executor process 起動・監視

executor process
  git checkout 済み workspace 内で setup / entry.command を実行
  stdout / stderr をファイルへ書く
  result file を読む
  exit_code / duration / result summary を supervisor に返す
```

要件:

- command 実行は worker supervisor と同一プロセスで直接行わない
- executor process が異常終了しても worker supervisor は継続する
- executor process が timeout を超えたら supervisor が kill する
- executor process の stdout/stderr は supervisor 側で上限付きに保存する
- executor process の終了結果は `exit_code` / `signal` / `reason` として記録する
- worker supervisor は executor failure を job failure として扱い、次の job を処理できる状態に戻る

MVP では1 worker あたり同時実行 job は1つでよい。

## 8. Params

params は任意の JSON object。

MVP では `json_file` を標準にする。

worker は command 実行前に以下を書き出す。

```json
{
  "job_id": "job_001",
  "params": {
    "top_k": 8,
    "dataset": "qa_eval_v3"
  }
}
```

デフォルトパス:

```text
.git-runner/params.json
```

CLI args / environment variables への展開は将来拡張でよい。

## 9. Output Schema

`git-runner` は汎用品なので、output schema は optional。

### 9.1 schema なし

```json
{
  "outputs": {
    "result": {
      "path": ".git-runner/result.json",
      "schema": {
        "type": "none"
      }
    }
  }
}
```

この場合:

- result file がなくてもよい
- exit_code / stdout / stderr / duration だけで job status を決める
- result file があれば raw JSON として保存してよい

### 9.2 schema あり

```json
{
  "outputs": {
    "result": {
      "path": ".research-run/result.json",
      "schema": {
        "type": "json_schema",
        "file": "schemas/research-result.schema.json"
      }
    }
  }
}
```

この場合:

- result file は必須
- JSON parse できなければ error
- JSON Schema に合わなければ error
- command が成功していても result invalid なら job は失敗扱い

MVP では builtin schema は不要。

Research Booster 連携では、Research Booster 側が schema file を提供する。

## 10. Result Contract 例

Research Booster 用の result schema は別管理でよいが、イメージは以下。

```json
{
  "schema_version": 1,
  "status": "completed",
  "metrics": {
    "accuracy": 0.82,
    "latency_p95_ms": 1430,
    "cost_usd": 1.27
  },
  "artifacts": [
    {
      "name": "report",
      "path": "results/report.md",
      "kind": "report",
      "media_type": "text/markdown"
    }
  ],
  "summary": "top_k=8 improved recall but increased latency."
}
```

`git-runner` 本体はこの意味を解釈しない。

schema validation と artifact 回収だけを行う。

## 11. Status

最低限の job status:

```text
PENDING
RUNNING
COMPLETED
FAILED
CANCELLED
```

詳細 reason:

```text
command_failed
timeout
result_missing
result_invalid
git_checkout_failed
worker_auth_failed
worker_policy_denied
```

terminal status を増やしすぎず、`status + reason` で表現する。

## 12. Logs / Artifacts

worker は最低限以下を保存する。

```text
.git-runner/stdout.log
.git-runner/stderr.log
.git-runner/result.json
```

job result には以下を含める。

```json
{
  "exit_code": 0,
  "duration_ms": 12345,
  "stdout_bytes": 1000,
  "stderr_bytes": 100,
  "result": {}
}
```

artifacts は job spec で指定された path を回収する。

MVP では local filesystem / NATS object store / simple HTTP upload のどれか一つでよい。

## 13. Worker Security

worker は任意 command を実行するため、最低限の安全策が必要。

MVP 要件:

- worker key
- worker id
- allowed tags
- allowed repositories
- timeout
- max stdout/stderr size
- workspace cleanup
- executor process isolation

worker config 例:

```json
{
  "worker_id": "local-001",
  "tags": ["default"],
  "allowed_tags": ["default", "gpu-large"],
  "allowed_repos": [
    "git@github.com:user/project.git"
  ],
  "workspace_root": ".git-runner/workspaces",
  "repo_cache_root": ".git-runner/repo-cache"
}
```

command allowlist は MVP では必須にしない。

worker は信頼できる環境に置く前提にする。

## 14. NATS

NATS は job queue / status event / worker coordination に使う。

MVP では単一 NATS server でよい。

```text
submitter
  job を publish

worker
  job を subscribe / pull

status
  job status を publish / store
```

### 14.1 Worker Tags / Queue Routing

worker は `tags` を持つ。

job は `worker.tags` を指定し、対応する tag の worker だけが受け取る。

用途:

- CPU only worker
- GPU worker
- large VRAM worker
- high memory worker
- trusted private repo worker
- cheap/slow worker
- fast/expensive worker

例:

```json
{
  "worker": {
    "tags": ["gpu-large"]
  },
  "execution": {
    "timeout_sec": 7200
  }
}
```

worker 起動例:

```bash
git-runner worker \
  --worker-id gpu-001 \
  --tags gpu-large,cuda \
  --worker-key $GIT_RUNNER_WORKER_KEY
```

NATS subject は tag ごとに分ける。

例:

```text
git-runner.jobs.default
git-runner.jobs.gpu-small
git-runner.jobs.gpu-large
git-runner.jobs.high-memory
```

MVP では job は1つの routing tag に publish されればよい。

将来的には複数 tag の AND / OR 条件を追加できる。

```json
{
  "worker": {
    "required_tags": ["gpu", "vram-24gb"]
  }
}
```

MVP では単純に `worker.tags[0]` を routing tag として使う。

NATS server は `git-runner` に同梱しない。

基本は外部で NATS server を起動し、`NATS_URL` を指定する。

```bash
GIT_RUNNER_NATS_URL=nats://localhost:4222
```

Windows では例えば以下のように導入できる。

```bash
scoop install main/nats-server
```

NATS server 起動補助は MVP では持たない。

## 15. Runtime

MVP:

```json
{
  "runtime": {
    "type": "host"
  }
}
```

将来:

```json
{
  "runtime": {
    "type": "docker",
    "dockerfile": "Dockerfile",
    "context": "."
  }
}
```

Dockerfile が repo に含まれていれば、commit SHA によって環境定義も固定できる。

## 16. MVP スコープ

最初に作るもの:

- npm package
- `git-runner` bin
- `git-runner submit`
- `git-runner worker`
- `git-runner status`
- Git commit SHA 固定
- worker の clone/fetch/checkout
- command execution
- worker supervisor / executor process separation
- params json file
- stdout/stderr/exit_code/duration
- optional result JSON validation
- worker key
- worker tags
- allowed repo/tag
- NATS_URL 接続

後回し:

- Docker runtime
- Kubernetes
- multi-worker scaling tuning
- NATS server 起動補助
- NATS cluster bootstrap
- artifact store の本格化
- command allowlist
- Research Booster builtin schema
- web dashboard
- PR 作成

## 17. Research Booster との関係

Research Booster は `git-runner` を実行基盤として使う。

```text
Research Booster
  hypothesis / experiment / finding を管理
  git-runner job を作る
  result schema を指定する
  結果を解釈する

git-runner
  job を実行する
  result schema を検証する
  logs / artifacts を返す
```

Research Booster 固有の知識は `git-runner` に入れない。

## 18. 一言まとめ

`git-runner` は、Git commit で固定された任意プロジェクトを NATS 経由で worker に配り、任意 command を実行し、stdout/stderr/exit_code と optional schema 付き result を回収する JS/npm 製の汎用分散 runner である。
