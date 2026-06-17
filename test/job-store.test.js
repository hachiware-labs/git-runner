import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireJobExecutionLock,
  releaseJobExecutionLock,
  writeResultSummary
} from "../src/job-store.js";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "git-runner-job-store-test-"));
}

test("job execution lock is exclusive and releasable", async () => {
  const cwd = await tempDir();
  const jobStoreRoot = path.join(cwd, "jobs");

  const first = await acquireJobExecutionLock({ cwd, jobStoreRoot, env: {}, jobId: "job_lock", workerId: "worker-a" });
  assert.equal(first.acquired, true);

  const owner = JSON.parse(await readFile(path.join(jobStoreRoot, "job_lock", "execution.lock", "owner.json"), "utf8"));
  assert.equal(owner.worker_id, "worker-a");

  const second = await acquireJobExecutionLock({ cwd, jobStoreRoot, env: {}, jobId: "job_lock", workerId: "worker-b" });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "locked");

  await releaseJobExecutionLock(first.lock);
  const third = await acquireJobExecutionLock({ cwd, jobStoreRoot, env: {}, jobId: "job_lock", workerId: "worker-b" });
  assert.equal(third.acquired, true);
  await releaseJobExecutionLock(third.lock);
});

test("job execution lock is skipped when terminal result already exists", async () => {
  const cwd = await tempDir();
  const jobStoreRoot = path.join(cwd, "jobs");

  await writeResultSummary({
    cwd,
    jobStoreRoot,
    env: {},
    summary: {
      job_id: "job_done",
      status: "COMPLETED",
      reason: null
    }
  });

  const result = await acquireJobExecutionLock({ cwd, jobStoreRoot, env: {}, jobId: "job_done", workerId: "worker-a" });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, "terminal");
  assert.equal(result.summary.status, "COMPLETED");
});
