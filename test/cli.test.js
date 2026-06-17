import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/errors.js";

function memoryStream() {
  return {
    data: "",
    write(chunk) {
      this.data += chunk;
    }
  };
}

async function runCli(argv, cwd) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const exitCode = await main(argv, {
    cwd,
    stdout,
    stderr,
    env: {}
  });
  return { exitCode, stdout: stdout.data, stderr: stderr.data };
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "git-runner-test-"));
}

test("init creates default project config and does not overwrite it", async () => {
  const cwd = await tempDir();

  const first = await runCli(["init"], cwd);
  assert.equal(first.exitCode, EXIT_CODES.success);
  assert.match(first.stdout, /created config:/);

  const configPath = path.join(cwd, ".git-runner", "config.json");
  const createdConfig = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(createdConfig.schema_version, 1);
  assert.equal(createdConfig.job_store_root, ".git-runner/jobs");

  await writeFile(configPath, `${JSON.stringify({ schema_version: 1, custom: true })}\n`);
  const second = await runCli(["init"], cwd);
  assert.equal(second.exitCode, EXIT_CODES.success);
  assert.match(second.stdout, /config already exists:/);

  const existingConfig = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(existingConfig.custom, true);
});

test("status, logs, and get read from local job store", async () => {
  const cwd = await tempDir();
  const jobDir = path.join(cwd, ".git-runner", "jobs", "job_001");
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "status.json"), `${JSON.stringify({
    job_id: "job_001",
    status: "COMPLETED",
    reason: null,
    worker_id: "local-001",
    source: { commit: "abc123" }
  })}\n`);
  await writeFile(path.join(jobDir, "stdout.log"), "hello\n");
  await writeFile(path.join(jobDir, "stderr.log"), "warn\n");
  await writeFile(path.join(jobDir, "result-summary.json"), `${JSON.stringify({
    job_id: "job_001",
    status: "COMPLETED",
    result: { ok: true }
  })}\n`);

  const status = await runCli(["status", "job_001"], cwd);
  assert.equal(status.exitCode, EXIT_CODES.success);
  assert.match(status.stdout, /status: COMPLETED/);
  assert.match(status.stdout, /commit: abc123/);

  const logs = await runCli(["logs", "job_001"], cwd);
  assert.equal(logs.exitCode, EXIT_CODES.success);
  assert.equal(logs.stdout, "hello\nwarn\n");

  const result = await runCli(["get", "job_001", "--json"], cwd);
  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.deepEqual(JSON.parse(result.stdout).result, { ok: true });
});

test("missing job returns job store failure exit code", async () => {
  const cwd = await tempDir();
  const result = await runCli(["status", "job_missing"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.jobStoreFailure);
  assert.match(result.stderr, /job not found/);
});
