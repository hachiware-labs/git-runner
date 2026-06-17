import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/errors.js";

const execFileAsync = promisify(execFile);

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

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function createGitRepo() {
  const repo = await tempDir();
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repo, "file.txt"), "one\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function head(repo) {
  return git(repo, ["rev-parse", "HEAD"]);
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

  await writeFile(path.join(jobDir, "status.json"), `${JSON.stringify({
    job_id: "job_001",
    status: "ACCEPTED",
    reason: null,
    worker_id: "local-001",
    timestamp: "2000-01-01T00:00:00.000Z",
    source: { commit: "abc123" }
  })}\n`);
  const accepted = await runCli(["status", "job_001"], cwd);
  assert.equal(accepted.exitCode, EXIT_CODES.success);
  assert.match(accepted.stdout, /status: ACCEPTED/);
  assert.match(accepted.stdout, /stale: true/);

  const acceptedJson = await runCli(["status", "job_001", "--json", "--stale-after-sec", "1"], cwd);
  assert.equal(acceptedJson.exitCode, EXIT_CODES.success);
  const acceptedStatus = JSON.parse(acceptedJson.stdout);
  assert.equal(acceptedStatus.stale, true);
  assert.equal(acceptedStatus.stale_after_sec, 1);
  assert.ok(acceptedStatus.age_sec > 0);

  const lockDir = path.join(jobDir, "execution.lock");
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_001",
    worker_id: "local-001",
    pid: 123,
    acquired_at: "2000-01-01T00:00:00.000Z"
  })}\n`);
  const locked = await runCli(["status", "job_001", "--json", "--stale-after-sec", "1"], cwd);
  assert.equal(locked.exitCode, EXIT_CODES.success);
  const lockedStatus = JSON.parse(locked.stdout);
  assert.equal(lockedStatus.execution_lock.present, true);
  assert.equal(lockedStatus.execution_lock.worker_id, "local-001");
  assert.equal(lockedStatus.execution_lock.stale, true);

  const lockedHuman = await runCli(["status", "job_001", "--stale-after-sec", "1"], cwd);
  assert.equal(lockedHuman.exitCode, EXIT_CODES.success);
  assert.match(lockedHuman.stdout, /execution_lock: present/);
  assert.match(lockedHuman.stdout, /execution_lock_stale: true/);

  const logs = await runCli(["logs", "job_001"], cwd);
  assert.equal(logs.exitCode, EXIT_CODES.success);
  assert.equal(logs.stdout, "hello\nwarn\n");

  const result = await runCli(["get", "job_001", "--json"], cwd);
  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.deepEqual(JSON.parse(result.stdout).result, { ok: true });
});

test("logs supports stdout/stderr selection and stream flag for local job store", async () => {
  const cwd = await tempDir();
  const jobDir = path.join(cwd, ".git-runner", "jobs", "job_logs");
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "stdout.log"), "out\n");
  await writeFile(path.join(jobDir, "stderr.log"), "err\n");

  const stdoutOnly = await runCli(["logs", "job_logs", "--stdout", "--stream"], cwd);
  assert.equal(stdoutOnly.exitCode, EXIT_CODES.success);
  assert.equal(stdoutOnly.stdout, "out\n");

  const stderrOnly = await runCli(["logs", "job_logs", "--stderr"], cwd);
  assert.equal(stderrOnly.exitCode, EXIT_CODES.success);
  assert.equal(stderrOnly.stdout, "err\n");
});

test("get copies collected artifacts to output directory", async () => {
  const cwd = await tempDir();
  const jobDir = path.join(cwd, ".git-runner", "jobs", "job_artifacts");
  await mkdir(path.join(jobDir, "artifacts"), { recursive: true });
  await writeFile(path.join(jobDir, "artifacts", "report"), "# Report\n");
  await writeFile(path.join(jobDir, "result-summary.json"), `${JSON.stringify({
    job_id: "job_artifacts",
    status: "COMPLETED",
    result: {},
    artifacts: [
      {
        name: "report",
        stored_path: path.join("artifacts", "report"),
        missing: false
      }
    ]
  })}\n`);

  const outputDir = path.join(cwd, "downloaded");
  const result = await runCli(["get", "job_artifacts", "--output", outputDir], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.equal(await readFile(path.join(outputDir, "report"), "utf8"), "# Report\n");
});

test("missing job returns job store failure exit code", async () => {
  const cwd = await tempDir();
  const result = await runCli(["status", "job_missing"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.jobStoreFailure);
  assert.match(result.stderr, /job not found/);
});

test("status rejects invalid stale threshold", async () => {
  const cwd = await tempDir();
  const result = await runCli(["status", "job_001", "--stale-after-sec", "0"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.invalidUsage);
  assert.match(result.stderr, /--stale-after-sec/);
});

test("submit rejects conflicting JetStream and core publish-only options", async () => {
  const cwd = await tempDir();
  const result = await runCli(["submit", "--command", "npm test", "--jetstream", "--no-require-worker"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.invalidUsage);
  assert.match(result.stderr, /--jetstream cannot be combined/);
});

test("worker refuses to start without worker key", async () => {
  const cwd = await tempDir();
  const result = await runCli(["worker", "--worker-id", "local-001", "--once"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.invalidUsage);
  assert.match(result.stderr, /missing worker key/);
});

test("submit dry-run resolves current HEAD into a Job Spec", async () => {
  const repo = await createGitRepo();
  const expectedCommit = await head(repo);

  const result = await runCli(["submit", "--repo", repo, "--command", "npm test", "--dry-run", "--json"], repo);

  assert.equal(result.exitCode, EXIT_CODES.success);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dry_run, true);
  assert.equal(output.commit, expectedCommit);
  assert.equal(output.subject, "git-runner.jobs.default");
  assert.equal(output.job_spec.source.commit, expectedCommit);
  assert.equal(output.job_spec.source.repo, repo);
  assert.equal(output.job_spec.entry.command, "npm test");
});

test("submit dry-run resolves branch when commit is not provided", async () => {
  const repo = await createGitRepo();
  const mainCommit = await head(repo);
  await git(repo, ["checkout", "-b", "experiment"]);
  await writeFile(path.join(repo, "file.txt"), "two\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "experiment"]);
  const experimentCommit = await head(repo);
  await git(repo, ["checkout", mainCommit]);

  const result = await runCli([
    "submit",
    "--repo",
    repo,
    "--branch",
    "experiment",
    "--command",
    "npm test",
    "--dry-run",
    "--json"
  ], repo);

  assert.equal(result.exitCode, EXIT_CODES.success);
  const output = JSON.parse(result.stdout);
  assert.equal(output.commit, experimentCommit);
  assert.equal(output.job_spec.source.branch, "experiment");
});

test("submit dry-run gives explicit commit precedence over branch", async () => {
  const repo = await createGitRepo();
  const explicitCommit = await head(repo);
  await git(repo, ["checkout", "-b", "experiment"]);
  await writeFile(path.join(repo, "file.txt"), "two\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "experiment"]);

  const result = await runCli([
    "submit",
    "--repo",
    repo,
    "--branch",
    "experiment",
    "--commit",
    explicitCommit,
    "--command",
    "npm test",
    "--dry-run",
    "--json"
  ], repo);

  assert.equal(result.exitCode, EXIT_CODES.success);
  const output = JSON.parse(result.stdout);
  assert.equal(output.commit, explicitCommit);
  assert.equal(output.job_spec.source.branch, "experiment");
});

test("submit dry-run warns when working tree is dirty without commit-and-push", async () => {
  const repo = await createGitRepo();
  await writeFile(path.join(repo, "dirty.txt"), "dirty\n");

  const result = await runCli(["submit", "--repo", repo, "--command", "npm test", "--dry-run", "--json"], repo);

  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.match(result.stderr, /uncommitted changes/);
});

test("submit fails with git exit code for non-repository path", async () => {
  const cwd = await tempDir();

  const result = await runCli(["submit", "--repo", cwd, "--command", "npm test", "--dry-run"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.gitFailure);
  assert.match(result.stderr, /git rev-parse --show-toplevel failed/);
});

test("submit commit-and-push creates branch, commits changes, and pushes to origin", async () => {
  const remote = await tempDir();
  await git(remote, ["init", "--bare"]);
  const repo = await createGitRepo();
  await git(repo, ["remote", "add", "origin", remote]);
  await writeFile(path.join(repo, "new-file.txt"), "new\n");

  const result = await runCli([
    "submit",
    "--repo",
    repo,
    "--command",
    "npm test",
    "--commit-and-push",
    "--branch",
    "codex/exp",
    "--message",
    "commit for runner",
    "--dry-run",
    "--json"
  ], repo);

  assert.equal(result.exitCode, EXIT_CODES.success);
  const output = JSON.parse(result.stdout);
  const branchCommit = await git(repo, ["rev-parse", "codex/exp"]);
  const remoteCommit = await git(repo, ["ls-remote", "origin", "refs/heads/codex/exp"]);
  const dirty = await git(repo, ["status", "--porcelain"]);

  assert.equal(output.commit, branchCommit);
  assert.match(remoteCommit, new RegExp(`^${branchCommit}\\s+refs/heads/codex/exp$`));
  assert.equal(dirty, "");
  assert.equal(await git(repo, ["log", "-1", "--pretty=%s"]), "commit for runner");
});
