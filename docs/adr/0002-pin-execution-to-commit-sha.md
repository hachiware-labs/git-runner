# ADR 0002: Pin execution to commit SHA

## Status

Accepted

## Context

`git-runner` は再現可能な command execution を提供する必要がある。branch は submit 後に進む可能性があり、worker が branch を checkout すると submit 時点と異なる code を実行する危険がある。

利用者は branch を指定することも commit を指定することもある。両方指定された場合の優先順位を明確にする必要がある。

## Decision

実行対象の正本は commit SHA とする。

ref 解決の優先順位:

1. `commit` が明示指定されている場合、`commit` を実行対象として固定する。
2. `commit` が未指定で `branch` が指定されている場合、submit 時点で branch HEAD を commit SHA に解決して固定する。
3. `commit` と `branch` が両方指定された場合、`commit` を優先する。

worker は branch を再解決しない。job spec の `source.commit` を使い、以下に相当する処理で detached HEAD に checkout する。

```bash
git fetch origin
git checkout --detach <commit-sha>
```

`source.branch` は provenance として保持してよいが、実行対象の正本ではない。

MVP では `commit` と `branch` の整合性検査は必須にしない。将来的に warning または strict mode として追加できる。

## Consequences

- submit 後に branch が進んでも job の再現性を保てる。
- worker workspace の状態が明確になる。
- branch と commit が不整合でも、MVP では commit が実行される。
- submitter は commit SHA を job spec に必ず含める必要がある。

## Alternatives Considered

### Worker が branch を checkout する

branch が変化すると再現性が失われるため採用しない。

### `branch` と `commit` が両方ある場合に error にする

厳密だが、外部システムが provenance として branch を付与したいケースを阻害する。MVP では commit 優先とし、必要なら将来 strict validation を追加する。
