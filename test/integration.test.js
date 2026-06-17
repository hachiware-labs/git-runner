import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function tempDir(prefix = "git-runner-it-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function createRunnableRepo() {
  const repo = await tempDir("git-runner-source-");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await mkdir(path.join(repo, ".git-runner"), { recursive: true });
  await writeFile(path.join(repo, ".git-runner", "config.json"), `${JSON.stringify({
    schema_version: 1,
    nats_url: "nats://localhost:4222",
    default_worker_tags: ["default"],
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
      artifacts: [
        {
          name: "report",
          path: "results/report.md",
          kind: "report",
          media_type: "text/markdown"
        }
      ]
    },
    execution: {
      timeout_sec: 3600,
      max_stdout_bytes: 10485760,
      max_stderr_bytes: 10485760
    },
    job_store_root: ".git-runner/jobs"
  }, null, 2)}\n`);
  await writeFile(path.join(repo, "run.js"), [
    "const fs = require('fs');",
    "fs.mkdirSync('.git-runner', { recursive: true });",
    "fs.mkdirSync('results', { recursive: true });",
    "fs.writeFileSync('.git-runner/result.json', JSON.stringify({ ok: true }));",
    "fs.writeFileSync('results/report.md', '# Report\\n');",
    "console.log('worker-ran');",
    ""
  ].join("\n"));
  await git(repo, ["add", ".git-runner/config.json", "run.js"]);
  await git(repo, ["commit", "-m", "add runnable script"]);
  return repo;
}

function natsServerPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const candidate = path.join(
    localAppData,
    "Microsoft",
    "WinGet",
    "Packages",
    "NATSAuthors.NATSServer_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "nats-server-v2.10.25-windows-amd64",
    "nats-server.exe"
  );
  return existsSync(candidate) ? candidate : null;
}

function runNode(args, cwd) {
  return execFileAsync(process.execPath, args, { cwd, windowsHide: true });
}

test("submit publishes to NATS and worker --once executes the command", async (t) => {
  const natsPath = natsServerPath();
  if (!natsPath) {
    t.skip("NATS server path is not available");
    return;
  }

  const port = 4230 + Math.floor(Math.random() * 200);
  const nats = spawn(natsPath, ["-p", String(port)], { windowsHide: true });
  t.after(() => {
    nats.kill();
  });
  await new Promise((resolve) => setTimeout(resolve, 750));

  const sourceRepo = await createRunnableRepo();
  const runnerRoot = await tempDir("git-runner-worker-");
  const jobStoreRoot = path.join(runnerRoot, ".git-runner", "jobs");
  const workspaceRoot = path.join(runnerRoot, ".git-runner", "workspaces");
  await mkdir(runnerRoot, { recursive: true });

  const worker = spawn(process.execPath, [
    path.join(repoRoot, "bin", "git-runner.js"),
    "worker",
    "--worker-id",
    "it-worker",
    "--worker-key",
    "dev",
    "--allow-all-repos",
    "--job-store-root",
    jobStoreRoot,
    "--workspace-root",
    workspaceRoot,
    "--nats-url",
    `nats://127.0.0.1:${port}`,
    "--once"
  ], {
    cwd: runnerRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let workerStdout = "";
  let workerStderr = "";
  worker.stdout.on("data", (chunk) => {
    workerStdout += chunk.toString();
  });
  worker.stderr.on("data", (chunk) => {
    workerStderr += chunk.toString();
  });
  t.after(() => {
    worker.kill();
  });

  await new Promise((resolve) => setTimeout(resolve, 750));

  const submit = await runNode([
    path.join(repoRoot, "bin", "git-runner.js"),
    "submit",
    "--repo",
    sourceRepo,
    "--command",
    "node run.js",
    "--job-store-root",
    jobStoreRoot,
    "--nats-url",
    `nats://127.0.0.1:${port}`,
    "--json"
  ], sourceRepo);
  const submitOutput = JSON.parse(submit.stdout);

  const workerExit = await new Promise((resolve) => {
    worker.on("exit", (code) => resolve(code));
  });
  assert.equal(workerExit, 0, workerStderr);
  assert.match(workerStdout, /worker processed one job/);

  const status = JSON.parse(await readFile(path.join(jobStoreRoot, submitOutput.job_id, "status.json"), "utf8"));
  const result = JSON.parse(await readFile(path.join(jobStoreRoot, submitOutput.job_id, "result-summary.json"), "utf8"));
  const stdout = await readFile(path.join(jobStoreRoot, submitOutput.job_id, "stdout.log"), "utf8");

  assert.equal(status.status, "COMPLETED");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.result, { ok: true });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].name, "report");
  assert.equal(result.artifacts[0].missing, false);
  assert.equal(result.artifacts[0].media_type, "text/markdown");
  assert.match(stdout, /worker-ran/);
  const artifact = await readFile(path.join(jobStoreRoot, submitOutput.job_id, result.artifacts[0].stored_path), "utf8");
  assert.equal(artifact, "# Report\n");
});
import { existsSync } from "node:fs";
