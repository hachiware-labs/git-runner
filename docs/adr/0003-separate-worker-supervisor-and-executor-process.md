# ADR 0003: Separate worker supervisor and executor process

## Status

Accepted

## Context

worker は任意 command を実行する。実行対象 command は crash、hang、timeout、memory overuse、signal failure、stdout/stderr flood を起こす可能性がある。

worker supervisor が command を同一プロセスで直接実行すると、job 実行の失敗が worker 本体の停止につながり、次の job を処理できなくなる。

## Decision

worker は supervisor process と executor process の 2 層構造にする。

```text
worker supervisor
  NATS connection
  job pull
  heartbeat
  status publish
  workspace management
  policy validation
  executor process launch / monitor / kill

executor process
  runs inside checked-out workspace
  writes params file
  runs setup commands
  runs entry.command
  writes stdout/stderr files
  reads result file
  returns exit_code / signal / duration / result summary
```

要件:

- command 実行は worker supervisor と同一プロセスで直接行わない。
- executor process が異常終了しても worker supervisor は継続する。
- executor process が timeout を超えたら supervisor が kill する。
- executor process の stdout/stderr は上限付きで保存する。
- executor process の終了結果は `exit_code` / `signal` / `reason` として記録する。
- worker supervisor は executor failure を job failure として扱い、次の job を処理できる状態に戻る。
- MVP では 1 worker あたり同時実行 job は 1 つとする。

## Consequences

- worker 本体の耐障害性が上がる。
- timeout と signal handling を supervisor 側で制御できる。
- executor protocol を定義する必要がある。
- 実装は単純な in-process command execution より複雑になる。

## Alternatives Considered

### Worker process が直接 command を実行する

実装は簡単だが、command failure が worker 本体に波及しやすいため採用しない。

### Container runtime を必須にする

isolation は強いが、MVP の導入コストが上がる。host runtime を MVP とし、Docker は将来拡張にする。
