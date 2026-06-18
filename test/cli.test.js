import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/errors.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

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

async function commandAvailable(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
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

function valueAtPath(value, fieldPath) {
  let current = value;
  const matcher = /([^.[\]]+)|\[(\d+)\]/g;
  for (const match of fieldPath.matchAll(matcher)) {
    const key = match[1] ?? Number(match[2]);
    current = current?.[key];
  }
  return current;
}

function validResultBundle() {
  return {
    schema_version: "git-runner.result-bundle.v1",
    job_id: "job_validate_bundle",
    status: "COMPLETED",
    reason: null,
    job: {
      job_id: "job_validate_bundle",
      params: {}
    },
    source: {
      type: "git",
      repo: "repo",
      commit: "abc123"
    },
    worker: {
      worker_id: "worker-001",
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
        file: "stdout.log",
        bytes: 0,
        truncated: false
      },
      stderr: {
        file: "stderr.log",
        bytes: 0,
        truncated: false
      },
      result: {
        path: ".git-runner/result.json",
        schema: {
          type: "none"
        },
        file: null,
        value: {
          ok: true
        },
        warnings: []
      },
      artifacts: []
    },
    error: null
  };
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

test("get writes a Result Bundle to the job store when bundle path is omitted", async () => {
  const cwd = await tempDir();
  const jobDir = path.join(cwd, ".git-runner", "jobs", "job_bundle");
  await mkdir(path.join(jobDir, "artifacts"), { recursive: true });
  await writeFile(path.join(jobDir, "job-spec.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_bundle",
    source: {
      type: "git",
      repo: "repo",
      commit: "abc123"
    },
    setup: [],
    entry: {
      type: "command",
      command: "npm test"
    },
    params: {
      sample: true
    },
    outputs: {
      result: {
        path: ".git-runner/result.json",
        schema: {
          type: "none"
        }
      },
      artifacts: []
    },
    worker: {
      tags: ["default"]
    }
  })}\n`);
  await writeFile(path.join(jobDir, "result-summary.json"), `${JSON.stringify({
    job_id: "job_bundle",
    status: "COMPLETED",
    reason: null,
    worker_id: "worker-001",
    source: {
      type: "git",
      repo: "repo",
      commit: "abc123"
    },
    exit_code: 0,
    signal: null,
    duration_ms: 12,
    stdout_bytes: 10,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    result: {
      ok: true
    },
    result_warnings: [],
    artifacts: [
      {
        name: "report",
        path: "results/report.md",
        stored_path: path.join("artifacts", "report.md"),
        size_bytes: 8,
        sha256: "abc123",
        missing: false
      }
    ],
    started_at: "2026-06-18T00:00:00.000Z",
    finished_at: "2026-06-18T00:00:01.000Z"
  })}\n`);

  const result = await runCli(["get", "job_bundle", "--bundle"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.match(result.stdout, /result_bundle:/);
  assert.match(result.stdout, /status: COMPLETED/);
  const bundle = JSON.parse(await readFile(path.join(jobDir, "result-bundle.json"), "utf8"));
  assert.equal(bundle.schema_version, "git-runner.result-bundle.v1");
  assert.equal(bundle.job_id, "job_bundle");
  assert.deepEqual(bundle.outputs.result.value, { ok: true });
  assert.equal(bundle.outputs.artifacts[0].file, path.join("artifacts", "report.md"));
});

test("get Result Bundle omits oversized result values for web-sized bundles", async () => {
  const cwd = await tempDir();
  const jobDir = path.join(cwd, ".git-runner", "jobs", "job_large_bundle");
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "job-spec.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_large_bundle",
    source: {
      type: "git",
      repo: "repo",
      commit: "abc123"
    },
    setup: [],
    entry: {
      type: "command",
      command: "npm test"
    },
    params: {},
    outputs: {
      result: {
        path: ".git-runner/result.json",
        schema: {
          type: "none"
        }
      },
      artifacts: []
    },
    worker: {
      tags: ["default"]
    }
  })}\n`);
  await writeFile(path.join(jobDir, "result-summary.json"), `${JSON.stringify({
    job_id: "job_large_bundle",
    status: "COMPLETED",
    reason: null,
    worker_id: "worker-001",
    source: {
      type: "git",
      repo: "repo",
      commit: "abc123"
    },
    exit_code: 0,
    signal: null,
    duration_ms: 12,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    result: {
      payload: "x".repeat(300000)
    },
    result_warnings: [],
    artifacts: [],
    started_at: "2026-06-18T00:00:00.000Z",
    finished_at: "2026-06-18T00:00:01.000Z"
  })}\n`);

  const result = await runCli(["get", "job_large_bundle", "--bundle", "large-bundle.json"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.match(result.stdout, /result_warning: result_omitted_from_bundle/);
  assert.match(result.stdout, /max_bytes: 262144/);
  const saved = JSON.parse(await readFile(path.join(cwd, "large-bundle.json"), "utf8"));
  assert.equal(saved.outputs.result.value, null);
  assert.equal(saved.outputs.result.warnings[0].code, "result_omitted_from_bundle");
  assert.equal(saved.outputs.result.warnings[0].max_bytes, 262144);
});

test("validate-bundle reports valid Result Bundle files", async () => {
  const cwd = await tempDir();
  const bundlePath = path.join(cwd, "result-bundle.json");
  await writeFile(bundlePath, `${JSON.stringify(validResultBundle(), null, 2)}\n`);

  const result = await runCli(["validate-bundle", "result-bundle.json"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.match(result.stdout, /valid: true/);
  assert.match(result.stdout, /job_id: job_validate_bundle/);
});

test("validate-bundle returns non-zero for malformed Result Bundle files", async () => {
  const cwd = await tempDir();
  const bundle = validResultBundle();
  bundle.status = "RUNNING";
  delete bundle.outputs.result.value;
  await writeFile(path.join(cwd, "bad-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);

  const result = await runCli(["validate-bundle", "bad-bundle.json", "--json"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.genericFailure);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  assert.ok(report.errors.length > 0);
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

test("recover-lock dry-run reports stale lock recovery preconditions", async () => {
  const cwd = await tempDir();
  const jobDir = path.join(cwd, ".git-runner", "jobs", "job_stale_lock");
  await mkdir(path.join(jobDir, "execution.lock"), { recursive: true });
  await writeFile(path.join(jobDir, "status.json"), `${JSON.stringify({
    job_id: "job_stale_lock",
    status: "ACCEPTED",
    reason: null,
    worker_id: "local-001"
  })}\n`);
  await writeFile(path.join(jobDir, "execution.lock", "owner.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_stale_lock",
    worker_id: "local-001",
    pid: 123,
    acquired_at: "2000-01-01T00:00:00.000Z"
  })}\n`);

  const result = await runCli(["recover-lock", "job_stale_lock", "--json", "--stale-after-sec", "1"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  const recovery = JSON.parse(result.stdout);
  assert.equal(recovery.dry_run, true);
  assert.equal(recovery.eligible, true);
  assert.equal(recovery.reason, "ready_for_manual_confirmation");
  assert.equal(recovery.execution_lock.worker_id, "local-001");
  assert.equal(recovery.execution_lock.stale, true);

  const human = await runCli(["recover-lock", "job_stale_lock", "--stale-after-sec", "1"], cwd);
  assert.equal(human.exitCode, EXIT_CODES.success);
  assert.match(human.stdout, /eligible: true/);
  assert.match(human.stdout, /next_steps:/);
});

test("recover-lock dry-run refuses terminal result recovery", async () => {
  const cwd = await tempDir();
  const jobDir = path.join(cwd, ".git-runner", "jobs", "job_done_lock");
  await mkdir(path.join(jobDir, "execution.lock"), { recursive: true });
  await writeFile(path.join(jobDir, "status.json"), `${JSON.stringify({
    job_id: "job_done_lock",
    status: "COMPLETED",
    reason: null,
    worker_id: "local-001"
  })}\n`);
  await writeFile(path.join(jobDir, "execution.lock", "owner.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_done_lock",
    worker_id: "local-001",
    pid: 123,
    acquired_at: "2000-01-01T00:00:00.000Z"
  })}\n`);
  await writeFile(path.join(jobDir, "result-summary.json"), `${JSON.stringify({
    job_id: "job_done_lock",
    status: "COMPLETED",
    reason: null
  })}\n`);

  const result = await runCli(["recover-lock", "job_done_lock", "--json", "--stale-after-sec", "1"], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  const recovery = JSON.parse(result.stdout);
  assert.equal(recovery.eligible, false);
  assert.equal(recovery.reason, "terminal_result_exists");
  assert.equal(recovery.terminal_result.status, "COMPLETED");
});

test("local run writes a completed result bundle", async () => {
  const cwd = await tempDir();
  const workspace = await tempDir();
  await mkdir(path.join(workspace, "schemas"), { recursive: true });
  await writeFile(path.join(workspace, "schemas", "result.schema.json"), `${JSON.stringify({
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean" }
    }
  })}\n`);
  await writeFile(path.join(workspace, "write-result.js"), [
    "import { readFile, writeFile, mkdir } from 'node:fs/promises';",
    "const input = JSON.parse(await readFile('.git-runner/params.json', 'utf8'));",
    "await mkdir('out', { recursive: true });",
    "await writeFile('out/result.json', JSON.stringify({ ok: input.params.ok }));",
    "await writeFile('out/report.txt', 'report');",
    "console.log('done');"
  ].join("\n"));
  await writeFile(path.join(workspace, "job.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_local_ok",
    source: {
      type: "git",
      repo: workspace,
      branch: "main",
      commit: "abc123"
    },
    working_dir: ".",
    setup: ["node --version"],
    entry: {
      type: "command",
      command: "node write-result.js"
    },
    params: {
      ok: true
    },
    param_passing: {
      mode: "json_file",
      path: ".git-runner/params.json"
    },
    outputs: {
      result: {
        path: "out/result.json",
        schema: {
          type: "json_schema",
          file: "schemas/result.schema.json"
        }
      },
      artifacts: [
        {
          name: "report",
          path: "out/report.txt",
          required: true
        }
      ]
    },
    execution: {
      timeout_sec: 5,
      max_stdout_bytes: 1000,
      max_stderr_bytes: 1000
    },
    worker: {
      routing_tag: "research"
    }
  }, null, 2)}\n`);

  const result = await runCli([
    "local",
    "run",
    "job.json",
    "--workspace",
    workspace,
    "--bundle",
    ".git-runner/result-bundle.json",
    "--worker-id",
    "local-test"
  ], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.match(result.stdout, /status: COMPLETED/);
  const bundle = JSON.parse(await readFile(path.join(workspace, ".git-runner", "result-bundle.json"), "utf8"));
  assert.equal(bundle.schema_version, "git-runner.result-bundle.v1");
  assert.equal(bundle.job_id, "job_local_ok");
  assert.equal(bundle.status, "COMPLETED");
  assert.equal(bundle.worker.worker_id, "local-test");
  assert.equal(bundle.worker.routing_tag, "research");
  assert.deepEqual(bundle.outputs.result.value, { ok: true });
  assert.equal(bundle.outputs.artifacts[0].missing, false);
});

test("local run omits oversized result values from web-sized bundles", async () => {
  const cwd = await tempDir();
  const workspace = await tempDir();
  await writeFile(path.join(workspace, "write-large-result.js"), [
    "import { writeFile, mkdir } from 'node:fs/promises';",
    "await mkdir('out', { recursive: true });",
    "await writeFile('out/result.json', JSON.stringify({ payload: 'x'.repeat(300000) }));"
  ].join("\n"));
  await writeFile(path.join(workspace, "job.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_local_large_result",
    source: {
      type: "git",
      repo: workspace,
      commit: "abc123"
    },
    working_dir: ".",
    setup: [],
    entry: {
      type: "command",
      command: "node write-large-result.js"
    },
    params: {},
    param_passing: {
      mode: "json_file",
      path: ".git-runner/params.json"
    },
    outputs: {
      result: {
        path: "out/result.json",
        schema: {
          type: "none"
        }
      },
      artifacts: []
    },
    execution: {
      timeout_sec: 5,
      max_stdout_bytes: 1000,
      max_stderr_bytes: 1000
    },
    worker: {
      tags: ["default"]
    }
  }, null, 2)}\n`);

  const result = await runCli([
    "local",
    "run",
    "job.json",
    "--workspace",
    workspace,
    "--bundle",
    ".git-runner/result-bundle.json"
  ], cwd);

  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.match(result.stdout, /status: COMPLETED/);
  assert.match(result.stdout, /result_warning: result_omitted_from_bundle/);
  assert.match(result.stdout, /max_bytes: 262144/);
  const bundle = JSON.parse(await readFile(path.join(workspace, ".git-runner", "result-bundle.json"), "utf8"));
  assert.equal(bundle.outputs.result.file, "out/result.json");
  assert.equal(bundle.outputs.result.value, null);
  assert.equal(bundle.outputs.result.warnings[0].code, "result_omitted_from_bundle");
  assert.equal(bundle.outputs.result.warnings[0].max_bytes, 262144);
});

test("local run writes a failed bundle for a missing required artifact", async () => {
  const workspace = await tempDir();
  await writeFile(path.join(workspace, "write-result.js"), [
    "import { writeFile, mkdir } from 'node:fs/promises';",
    "await mkdir('out', { recursive: true });",
    "await writeFile('out/result.json', JSON.stringify({ ok: true }));"
  ].join("\n"));
  await writeFile(path.join(workspace, "job.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_local_missing_artifact",
    source: {
      type: "git",
      repo: workspace,
      commit: "abc123"
    },
    working_dir: ".",
    setup: [],
    entry: {
      type: "command",
      command: "node write-result.js"
    },
    params: {},
    param_passing: {
      mode: "json_file",
      path: ".git-runner/params.json"
    },
    outputs: {
      result: {
        path: "out/result.json",
        schema: {
          type: "none"
        }
      },
      artifacts: [
        {
          name: "missing",
          path: "out/missing.txt",
          required: true
        }
      ]
    },
    execution: {
      timeout_sec: 5,
      max_stdout_bytes: 1000,
      max_stderr_bytes: 1000
    }
  }, null, 2)}\n`);

  const result = await runCli(["local", "run", "job.json", "--workspace", workspace, "--json"], workspace);

  assert.equal(result.exitCode, EXIT_CODES.genericFailure);
  const outputBundle = JSON.parse(result.stdout);
  assert.equal(outputBundle.status, "FAILED");
  assert.equal(outputBundle.reason, "artifact_missing");
  const savedBundle = JSON.parse(await readFile(path.join(workspace, ".git-runner", "result-bundle.json"), "utf8"));
  assert.equal(savedBundle.reason, "artifact_missing");
  assert.equal(savedBundle.outputs.artifacts[0].missing, true);
});

test("local run writes failed bundles for required result validation failures", async () => {
  const cases = [
    {
      jobId: "job_local_result_missing",
      script: [
        "import { mkdir } from 'node:fs/promises';",
        "await mkdir('out', { recursive: true });"
      ],
      reason: "result_missing",
      expectedFile: null,
      expectedValue: null
    },
    {
      jobId: "job_local_result_invalid",
      script: [
        "import { writeFile, mkdir } from 'node:fs/promises';",
        "await mkdir('out', { recursive: true });",
        "await writeFile('out/result.json', JSON.stringify({ ok: 'no' }));"
      ],
      reason: "result_invalid",
      expectedFile: "out/result.json",
      expectedValue: { ok: "no" }
    }
  ];

  for (const testCase of cases) {
    const workspace = await tempDir();
    await mkdir(path.join(workspace, "schemas"), { recursive: true });
    await writeFile(path.join(workspace, "schemas", "result.schema.json"), `${JSON.stringify({
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" }
      }
    })}\n`);
    await writeFile(path.join(workspace, "write-result.js"), testCase.script.join("\n"));
    await writeFile(path.join(workspace, "job.json"), `${JSON.stringify({
      schema_version: 1,
      job_id: testCase.jobId,
      source: {
        type: "git",
        repo: workspace,
        commit: "abc123"
      },
      working_dir: ".",
      setup: [],
      entry: {
        type: "command",
        command: "node write-result.js"
      },
      params: {},
      param_passing: {
        mode: "json_file",
        path: ".git-runner/params.json"
      },
      outputs: {
        result: {
          path: "out/result.json",
          schema: {
            type: "json_schema",
            file: "schemas/result.schema.json"
          }
        },
        artifacts: []
      },
      execution: {
        timeout_sec: 5,
        max_stdout_bytes: 1000,
        max_stderr_bytes: 1000
      }
    }, null, 2)}\n`);

    const result = await runCli(["local", "run", "job.json", "--workspace", workspace, "--json"], workspace);

    assert.equal(result.exitCode, EXIT_CODES.genericFailure, testCase.reason);
    const outputBundle = JSON.parse(result.stdout);
    const savedBundle = JSON.parse(await readFile(path.join(workspace, ".git-runner", "result-bundle.json"), "utf8"));
    assert.deepEqual(outputBundle, savedBundle, testCase.reason);
    assert.equal(savedBundle.schema_version, "git-runner.result-bundle.v1", testCase.reason);
    assert.equal(savedBundle.status, "FAILED", testCase.reason);
    assert.equal(savedBundle.reason, testCase.reason, testCase.reason);
    assert.equal(savedBundle.error.reason, testCase.reason, testCase.reason);
    assert.equal(savedBundle.error.emitted_by, "git-runner local run", testCase.reason);
    assert.equal(savedBundle.error.retryable, false, testCase.reason);
    assert.equal(savedBundle.outputs.result.schema.type, "json_schema", testCase.reason);
    assert.equal(savedBundle.outputs.result.file, testCase.expectedFile, testCase.reason);
    assert.deepEqual(savedBundle.outputs.result.value, testCase.expectedValue, testCase.reason);
    assert.equal(savedBundle.outputs.result.warnings[0].code, testCase.reason, testCase.reason);
    assert.equal(savedBundle.error.details[0].code, testCase.reason, testCase.reason);
  }
});

test("local run distinguishes setup failure from entry command failure", async () => {
  const workspace = await tempDir();
  await writeFile(path.join(workspace, "job.json"), `${JSON.stringify({
    schema_version: 1,
    job_id: "job_local_setup_failed",
    source: {
      type: "git",
      repo: workspace,
      commit: "abc123"
    },
    working_dir: ".",
    setup: [
      {
        type: "command",
        command: "node -e \"process.exit(7)\""
      }
    ],
    entry: {
      type: "command",
      command: "node -e \"process.exit(8)\""
    },
    params: {},
    param_passing: {
      mode: "json_file",
      path: ".git-runner/params.json"
    },
    outputs: {
      result: {
        path: ".git-runner/result.json",
        schema: {
          type: "none"
        }
      },
      artifacts: []
    },
    execution: {
      timeout_sec: 5,
      max_stdout_bytes: 1000,
      max_stderr_bytes: 1000
    }
  }, null, 2)}\n`);

  const result = await runCli(["local", "run", "job.json", "--workspace", workspace, "--json"], workspace);

  assert.equal(result.exitCode, EXIT_CODES.genericFailure);
  const bundle = JSON.parse(result.stdout);
  assert.equal(bundle.reason, "setup_failed");
  assert.equal(bundle.execution.exit_code, 7);
  assert.equal(bundle.execution.failed_stage, "setup");
});

test("local run satisfies the Research Booster acceptance sample", async (t) => {
  if (!(await commandAvailable("python"))) {
    t.skip("python command is not available for the Research Booster sample");
    return;
  }

  const workspace = await tempDir();
  await cp(
    path.join(repoRoot, "examples", "research-booster-local-runner"),
    path.join(workspace, "examples", "research-booster-local-runner"),
    { recursive: true }
  );
  const acceptancePath = path.join(workspace, "examples", "research-booster-local-runner", "local-runner-acceptance.json");
  const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
  assert.equal(
    acceptance.derived_from.acceptance_sample,
    "research-booster/examples/git-runner-research-booster-e2e/local-runner-acceptance.json"
  );
  assert.equal(
    acceptance.derived_from.path_rewrites[0].to,
    "examples/research-booster-local-runner/"
  );
  assert.equal(
    acceptance.schema_setup.local_schema,
    "examples/research-booster-local-runner/schemas/research-booster.v1.schema.json"
  );
  await mkdir(path.join(workspace, "schemas"), { recursive: true });
  await copyFile(
    path.join(workspace, acceptance.schema_setup.local_schema),
    path.join(workspace, acceptance.schema_setup.creates)
  );

  const result = await runCli([
    "local",
    "run",
    acceptance.job,
    "--workspace",
    workspace,
    "--bundle",
    acceptance.command_under_test.bundle,
    "--json"
  ], workspace);

  assert.equal(result.exitCode, acceptance.command_under_test.expected_exit_code);
  const stdoutBundle = JSON.parse(result.stdout);
  const savedBundle = JSON.parse(await readFile(path.join(workspace, acceptance.command_under_test.bundle), "utf8"));
  assert.deepEqual(stdoutBundle, savedBundle);
  for (const [fieldPath, expected] of Object.entries(acceptance.expected_bundle)) {
    assert.deepEqual(valueAtPath(savedBundle, fieldPath), expected, fieldPath);
  }
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
