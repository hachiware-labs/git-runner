# Git Spec

## 1. Repository Inputs

`git-runner submit` accepts:

- local repository path, default `.`
- remote repository URL is out of scope for MVP submit

MVP submit requires a local Git repository path. Job Specs can still contain remote repository URLs when produced by another submitter, as long as the worker can clone/fetch them.

## 2. Ref Resolution

Execution commit resolution is deterministic.

Priority:

1. Explicit `--commit <sha>`
2. Explicit `--branch <branch>` resolved at submit time
3. Current `HEAD`

If `--commit` and `--branch` are both provided, `--commit` wins.

Resolved commit SHA is stored in:

```json
{
  "source": {
    "commit": "<sha>"
  }
}
```

`source.branch` is stored for provenance when branch is provided, but worker must not use it as the execution target.

## 3. Dirty Working Tree

Without `--commit-and-push`:

- submit does not modify the repository.
- submit uses the resolved commit SHA.
- if working tree or index is dirty, submit emits a warning that uncommitted changes are not included.

With `--commit-and-push`:

- submit stages all changes with `git add -A`.
- submit commits staged changes when any exist.
- submit pushes the selected branch.
- submit resolves final HEAD after push.

## 4. Branch Handling

When `--branch <branch>` is provided with `--commit-and-push`:

- If branch exists locally, checkout it.
- Else create it from current HEAD.
- Push it to `origin`.

When `--branch <branch>` is provided without `--commit-and-push`:

- submit resolves that branch to a commit.
- submit does not checkout, create, commit, or push.

## 5. Worker Checkout

Worker checkout sequence:

```bash
git fetch origin
git checkout --detach <commit-sha>
```

Worker must treat checkout failure as:

```text
status: FAILED
reason: git_checkout_failed
```

## 6. Local Path Repositories

For local development, `source.repo` can be a local path. Worker clones from that path when accessible.

For distributed workers, `source.repo` must be a remote URL accessible from worker.

## 7. Provenance

Job result must preserve:

- source repo
- source branch when provided
- source commit

Provenance does not change execution authority. `source.commit` remains authoritative.
