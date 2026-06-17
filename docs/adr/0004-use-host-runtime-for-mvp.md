# ADR 0004: Use host runtime for MVP

## Status

Accepted

## Context

`git-runner` は実行対象の言語や build system を限定しない。Docker runtime を使うと環境の再現性を高められるが、Docker 導入、image build、cache、volume、network、credentials の扱いが MVP の複雑さを増やす。

## Decision

MVP の runtime は host runtime とする。

```json
{
  "runtime": {
    "type": "host"
  }
}
```

worker は checkout 済み workspace の `working_dir` で setup commands と entry command を実行する。

Docker runtime は将来拡張として扱う。

```json
{
  "runtime": {
    "type": "docker",
    "dockerfile": "Dockerfile",
    "context": "."
  }
}
```

## Consequences

- MVP の実装と導入が軽くなる。
- worker host に必要な言語 runtime や依存関係が入っている必要がある。
- 環境再現性は commit SHA だけでは完全には保証されない。
- Docker runtime を追加する場合、job spec と worker policy を拡張する必要がある。

## Alternatives Considered

### Docker runtime を MVP 必須にする

再現性と isolation は高いが、NATS / Git / executor separation という MVP の中核実装より先に runtime orchestration が重くなるため採用しない。
