# Research Booster Local Runner Fixture

This fixture is the git-runner-side acceptance contract for `git-runner local run`.

It is a path-rebased snapshot derived from the Research Booster E2E fixture:

- `docs/git-runner/implementation-briefs/0001-local-runner.md`
- `examples/git-runner-research-booster-e2e/local-runner-acceptance.json`
- `examples/git-runner-research-booster-e2e/local_runner_mock.py`

Only the sample paths are rewritten from `examples/git-runner-research-booster-e2e/` to `examples/research-booster-local-runner/`. The Python mock remains Research Booster-side reference material; the JS/npm implementation in this repository is the executable target.

The fixture is valid when:

1. Research Booster writes `schemas/research-booster.v1.schema.json`.
2. `git-runner local run examples/research-booster-local-runner/job.json --bundle .git-runner/result-bundle.json` exits `0`.
3. The bundle satisfies `local-runner-acceptance.json`.
4. Research Booster can import `.git-runner/result-bundle.json`.

`write_result.py` is a small sample command used by the job spec. It writes `.research-run/result.json` and `results/report.md`.
