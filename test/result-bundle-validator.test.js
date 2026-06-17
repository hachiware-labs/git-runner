import assert from "node:assert/strict";
import test from "node:test";
import { assertResultBundle, validateResultBundle } from "../src/result-bundle-validator.js";

function validBundle() {
  return {
    schema_version: "git-runner.result-bundle.v1",
    job_id: "job_001",
    status: "COMPLETED",
    reason: null,
    job: {
      job_id: "job_001",
      params: {}
    },
    source: {
      type: "git",
      repo: "repo",
      commit: "abc123"
    },
    worker: {
      worker_id: "local-001",
      routing_tag: "default"
    },
    timing: {
      submitted_at: "2026-06-18T00:00:00.000Z",
      started_at: "2026-06-18T00:00:00.000Z",
      finished_at: "2026-06-18T00:00:01.000Z",
      duration_ms: 1000
    },
    execution: {
      exit_code: 0,
      signal: null,
      timed_out: false,
      failed_stage: null,
      commands: ["npm test"]
    },
    outputs: {
      stdout: {
        file: ".git-runner/stdout.log",
        bytes: 0,
        truncated: false
      },
      stderr: {
        file: ".git-runner/stderr.log",
        bytes: 0,
        truncated: false
      },
      result: {
        path: ".git-runner/result.json",
        schema: {
          type: "none"
        },
        file: ".git-runner/result.json",
        value: {
          ok: true
        },
        warnings: []
      },
      artifacts: [
        {
          name: "report",
          path: "results/report.md",
          kind: "report",
          media_type: "text/markdown",
          required: false,
          file: "results/report.md",
          bytes: 8,
          sha256: "abc123",
          missing: false
        }
      ]
    },
    error: null
  };
}

test("Result Bundle validator accepts a valid v1 bundle", () => {
  const result = validateResultBundle(validBundle());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.doesNotThrow(() => assertResultBundle(validBundle()));
});

test("Result Bundle validator rejects malformed bundles", () => {
  const bundle = validBundle();
  delete bundle.outputs.result.value;
  bundle.status = "RUNNING";

  const result = validateResultBundle(bundle);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.instancePath === "/outputs/result"));
  assert.throws(() => assertResultBundle(bundle), /invalid Result Bundle/);
});
