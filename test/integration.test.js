import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { connect } from "@nats-io/transport-node";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function tempDir(prefix = "git-runner-it-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function createRunnableRepo({ commandScript = null, outputs = null, extraFiles = {} } = {}) {
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
    outputs: outputs ?? {
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
  await writeFile(path.join(repo, "run.js"), commandScript ?? [
    "const fs = require('fs');",
    "fs.mkdirSync('.git-runner', { recursive: true });",
    "fs.mkdirSync('results', { recursive: true });",
    "fs.writeFileSync('.git-runner/result.json', JSON.stringify({ ok: true }));",
    "fs.writeFileSync('results/report.md', '# Report\\n');",
    "console.log('worker-ran');",
    ""
  ].join("\n"));
  for (const [filePath, content] of Object.entries(extraFiles)) {
    const absolute = path.join(repo, filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await git(repo, ["add", "."]);
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

async function withNats(t, fn, { jetstream = false } = {}) {
  const natsPath = natsServerPath();
  if (!natsPath) {
    t.skip("NATS server path is not available");
    return;
  }

  const port = 4230 + Math.floor(Math.random() * 200);
  const storeDir = jetstream ? await tempDir("git-runner-js-store-") : null;
  const args = ["-p", String(port), ...(jetstream ? ["-js", "-sd", storeDir] : [])];
  const nats = spawn(natsPath, args, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  t.after(async () => {
    nats.kill();
    if (storeDir) {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
  await new Promise((resolve) => setTimeout(resolve, jetstream ? 1000 : 750));
  await fn({ natsUrl: `nats://127.0.0.1:${port}` });
}

function runNode(args, cwd) {
  return execFileAsync(process.execPath, args, { cwd, windowsHide: true });
}

async function createRunnerRoot() {
  const runnerRoot = await tempDir("git-runner-worker-");
  return {
    runnerRoot,
    jobStoreRoot: path.join(runnerRoot, ".git-runner", "jobs"),
    workspaceRoot: path.join(runnerRoot, ".git-runner", "workspaces")
  };
}

async function runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs = [] }) {
  const worker = spawn(process.execPath, [
    path.join(repoRoot, "bin", "git-runner.js"),
    "worker",
    "--worker-id",
    "it-worker",
    "--worker-key",
    "dev",
    "--job-store-root",
    jobStoreRoot,
    "--workspace-root",
    workspaceRoot,
    "--nats-url",
    natsUrl,
    "--once",
    ...extraArgs
  ], {
    cwd: runnerRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  worker.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitPromise = new Promise((resolve) => worker.on("exit", (code) => resolve(code)));
  t.after(() => {
    worker.kill();
  });
  await new Promise((resolve) => setTimeout(resolve, 750));
  return {
    wait: () => exitPromise,
    output: () => ({ stdout, stderr })
  };
}

async function submitJob({ sourceRepo, jobStoreRoot, natsUrl, command = "node run.js", extraArgs = [] }) {
  const submit = await runNode([
    path.join(repoRoot, "bin", "git-runner.js"),
    "submit",
    "--repo",
    sourceRepo,
    "--command",
    command,
    "--job-store-root",
    jobStoreRoot,
    "--nats-url",
    natsUrl,
    "--json",
    ...extraArgs
  ], sourceRepo);
  return JSON.parse(submit.stdout);
}

async function submitJobFailure({ sourceRepo, jobStoreRoot, natsUrl, command = "node run.js", extraArgs = [] }) {
  try {
    await runNode([
      path.join(repoRoot, "bin", "git-runner.js"),
      "submit",
      "--repo",
      sourceRepo,
      "--command",
      command,
      "--job-store-root",
      jobStoreRoot,
      "--nats-url",
      natsUrl,
      "--json",
      ...extraArgs
    ], sourceRepo);
  } catch (error) {
    return error;
  }
  throw new Error("submit unexpectedly succeeded");
}

async function readSummary(jobStoreRoot, jobId) {
  return JSON.parse(await readFile(path.join(jobStoreRoot, jobId, "result-summary.json"), "utf8"));
}

async function publishRawJob(natsUrl, subject, jobSpec) {
  const connection = await connect({ servers: natsUrl });
  connection.publish(subject, new TextEncoder().encode(JSON.stringify(jobSpec)));
  await connection.drain();
}

async function publishCancel(natsUrl, jobId) {
  const connection = await connect({ servers: natsUrl });
  connection.publish(`git-runner.cancels.${jobId}`, new TextEncoder().encode(JSON.stringify({ job_id: jobId })));
  await connection.drain();
}

test("submit dispatches to NATS and worker --once executes the command", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo();
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({
      t,
      runnerRoot,
      jobStoreRoot,
      workspaceRoot,
      natsUrl,
      extraArgs: ["--allow-all-repos"]
    });

    const submitOutput = await submitJob({ sourceRepo, jobStoreRoot, natsUrl });
    assert.equal(await worker.wait(), 0, worker.output().stderr);
    assert.match(worker.output().stdout, /worker processed one job/);

    const status = JSON.parse(await readFile(path.join(jobStoreRoot, submitOutput.job_id, "status.json"), "utf8"));
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
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
});

test("submit fails fast when no matching worker accepts dispatch", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo();
    const { jobStoreRoot } = await createRunnerRoot();

    const error = await submitJobFailure({ sourceRepo, jobStoreRoot, natsUrl });

    assert.equal(error.code, 4);
    assert.match(error.stderr, /no worker accepted/);
    assert.deepEqual(await readdir(jobStoreRoot), []);
  });
});

test("submit can bypass worker dispatch guard explicitly", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo();
    const { jobStoreRoot } = await createRunnerRoot();

    const submitOutput = await submitJob({
      sourceRepo,
      jobStoreRoot,
      natsUrl,
      extraArgs: ["--no-require-worker"]
    });
    const status = JSON.parse(await readFile(path.join(jobStoreRoot, submitOutput.job_id, "status.json"), "utf8"));

    assert.equal(status.status, "PENDING");
  });
});

test("jetstream submit persists job until worker starts", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo();
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();

    const submitOutput = await submitJob({
      sourceRepo,
      jobStoreRoot,
      natsUrl,
      extraArgs: ["--jetstream"]
    });

    const pending = JSON.parse(await readFile(path.join(jobStoreRoot, submitOutput.job_id, "status.json"), "utf8"));
    assert.equal(pending.status, "PENDING");

    const worker = await runWorkerOnce({
      t,
      runnerRoot,
      jobStoreRoot,
      workspaceRoot,
      natsUrl,
      extraArgs: ["--allow-all-repos", "--jetstream"]
    });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.result, { ok: true });
  }, { jetstream: true });
});

test("worker records worker_policy_denied when repository is not allowed", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo();
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl });
    const submitOutput = await submitJob({ sourceRepo, jobStoreRoot, natsUrl });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "worker_policy_denied");
  });
});

test("worker records worker_policy_denied when job tag is not allowed", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs: ["--allow-all-repos"] });

    await publishRawJob(natsUrl, "git-runner.jobs.default", {
      schema_version: 1,
      job_id: "job_tag_denied",
      source: {
        type: "git",
        repo: "unused",
        commit: "abc123"
      },
      working_dir: ".",
      setup: [],
      entry: {
        type: "command",
        command: "echo hi"
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
        timeout_sec: 3600,
        max_stdout_bytes: 10485760,
        max_stderr_bytes: 10485760
      },
      worker: {
        tags: ["gpu"]
      },
      runtime: {
        type: "host"
      }
    });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, "job_tag_denied");
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "worker_policy_denied");
  });
});

test("worker records command_failed for non-zero command exit", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo({ commandScript: "process.exit(7);\n" });
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs: ["--allow-all-repos"] });
    const submitOutput = await submitJob({ sourceRepo, jobStoreRoot, natsUrl });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "command_failed");
    assert.equal(result.exit_code, 7);
  });
});

test("worker records timeout when executor exceeds timeout", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo({ commandScript: "setTimeout(() => {}, 5000);\n" });
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs: ["--allow-all-repos"] });
    const submitOutput = await submitJob({ sourceRepo, jobStoreRoot, natsUrl, extraArgs: ["--timeout-sec", "1"] });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "timeout");
  });
});

test("worker records result_missing for required JSON schema result", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo({
      outputs: {
        result: {
          path: ".git-runner/result.json",
          schema: {
            type: "json_schema",
            file: "schemas/result.schema.json"
          }
        },
        artifacts: []
      },
      commandScript: "console.log('no-result');\n",
      extraFiles: {
        "schemas/result.schema.json": JSON.stringify({ type: "object" })
      }
    });
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs: ["--allow-all-repos"] });
    const submitOutput = await submitJob({ sourceRepo, jobStoreRoot, natsUrl });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "result_missing");
  });
});

test("worker records result_invalid for JSON schema validation failure", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo({
      outputs: {
        result: {
          path: ".git-runner/result.json",
          schema: {
            type: "json_schema",
            file: "schemas/result.schema.json"
          }
        },
        artifacts: []
      },
      commandScript: [
        "const fs = require('fs');",
        "fs.mkdirSync('.git-runner', { recursive: true });",
        "fs.writeFileSync('.git-runner/result.json', JSON.stringify({ ok: 'no' }));",
        ""
      ].join("\n"),
      extraFiles: {
        "schemas/result.schema.json": JSON.stringify({
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean" }
          }
        })
      }
    });
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs: ["--allow-all-repos"] });
    const submitOutput = await submitJob({ sourceRepo, jobStoreRoot, natsUrl });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "result_invalid");
  });
});

test("worker records CANCELLED when cancel subject is published", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const sourceRepo = await createRunnableRepo({ commandScript: "setTimeout(() => {}, 5000);\n" });
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs: ["--allow-all-repos"] });
    const submitOutput = await submitJob({ sourceRepo, jobStoreRoot, natsUrl });

    await new Promise((resolve) => setTimeout(resolve, 500));
    await publishCancel(natsUrl, submitOutput.job_id);

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, submitOutput.job_id);
    assert.equal(result.status, "CANCELLED");
    assert.equal(result.reason, "cancelled");
  });
});

test("worker records job_invalid for malformed job spec with job_id", async (t) => {
  await withNats(t, async ({ natsUrl }) => {
    const { runnerRoot, jobStoreRoot, workspaceRoot } = await createRunnerRoot();
    const worker = await runWorkerOnce({ t, runnerRoot, jobStoreRoot, workspaceRoot, natsUrl, extraArgs: ["--allow-all-repos"] });

    await publishRawJob(natsUrl, "git-runner.jobs.default", {
      schema_version: 1,
      job_id: "job_invalid_spec",
      source: {
        type: "git"
      }
    });

    assert.equal(await worker.wait(), 0, worker.output().stderr);
    const result = await readSummary(jobStoreRoot, "job_invalid_spec");
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "job_invalid");
  });
});
