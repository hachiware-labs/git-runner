# ADR 0005: Keep Research Booster semantics outside git-runner

## Status

Accepted

## Context

Research Booster は hypothesis、experiment、finding、recommendation を管理する。一方 `git-runner` は Git checkout と command execution を担当する汎用 runner である。

`git-runner` が Research Booster 固有の result semantics を解釈すると、汎用性が下がり、Research Booster 側の schema 変更が runner 実装に波及する。

## Decision

`git-runner` は Research Booster 固有の意味を解釈しない。

`git-runner` が扱うのは以下に限定する。

- job spec validation
- Git checkout
- params passing
- command execution
- stdout / stderr / exit_code / signal / duration collection
- optional result file parsing
- optional JSON Schema validation
- artifacts collection
- status / logs / result transport

result JSON の意味、metrics の評価、finding 生成、recommendation 生成は上位システムの責務とする。

## Consequences

- `git-runner` を Research Booster 以外にも使える。
- result schema は job spec で外部から渡す必要がある。
- schema validation はできるが、domain-specific validation はしない。

## Alternatives Considered

### Research Booster builtin schema を持つ

連携は簡単になるが、runner の責務が膨らむため MVP では採用しない。
