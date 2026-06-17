import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { loadWorkerConfig, resolvePath } from "./config.js";
import { CliError, EXIT_CODES } from "./errors.js";
import { checkoutDetached, cloneRepository, fetchRepository } from "./git.js";
import { resolveInside } from "./path-utils.js";
import { copyJobLogs, ensureJobDir, writeJobSpec, writeJobStatus, writeResultSummary } from "./job-store.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function runWorker(options) {
  const { config } = await loadWorkerConfig({
    cwd: options.cwd,
    configPath: options.configPath
  });
  const workerConfig = mergeWorkerOptions(config, options);

  validateWorkerStartup(workerConfig);

  const natsUrl = options.natsUrl ?? options.env.GIT_RUNNER_NATS_URL ?? "nats://localhost:4222";
  let connection;
  try {
    connection = await connect({ servers: natsUrl });
  } catch (error) {
    throw new CliError(`worker NATS connect failed at ${natsUrl}: ${error.message}`, EXIT_CODES.natsFailure);
  }

  const workerState = {
    status: "idle",
    current_job_id: null
  };
  await publish(connection, `git-runner.workers.${workerConfig.worker_id}.heartbeat`, {
    schema_version: 1,
    worker_id: workerConfig.worker_id,
    status: workerState.status,
    tags: workerConfig.tags,
    allow_all_repos: workerConfig.allow_all_repos,
    current_job_id: workerState.current_job_id,
    timestamp: new Date().toISOString()
  });
  const heartbeat = setInterval(() => {
    publish(connection, `git-runner.workers.${workerConfig.worker_id}.heartbeat`, {
      schema_version: 1,
      worker_id: workerConfig.worker_id,
      status: workerState.status,
      tags: workerConfig.tags,
      allow_all_repos: workerConfig.allow_all_repos,
      current_job_id: workerState.current_job_id,
      timestamp: new Date().toISOString()
    });
  }, 10000);

  try {
    const subscriptions = workerConfig.tags.map((tag) => connection.subscribe(`git-runner.jobs.${tag}`));
    const loops = subscriptions.map((subscription) => receiveLoop({ subscription, connection, workerConfig, options, workerState }));
    if (workerConfig.once) {
      await Promise.race(loops);
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      await connection.close();
    } else {
      await Promise.all(loops);
    }
  } finally {
    clearInterval(heartbeat);
    if (connection && !connection.isClosed()) {
      await connection.close();
    }
  }
}

function mergeWorkerOptions(config, options) {
  const cliTags = options.tags ? splitCsv(options.tags) : null;
  const allowRepos = [
    ...(config.allowed_repos ?? []),
    ...(options.allowRepos ?? [])
  ];
  return {
    ...config,
    worker_id: options.workerId ?? config.worker_id,
    worker_key: options.workerKey ?? options.env.GIT_RUNNER_WORKER_KEY,
    tags: cliTags ?? config.tags ?? ["default"],
    allowed_tags: config.allowed_tags ?? cliTags ?? config.tags ?? ["default"],
    allowed_repos: allowRepos,
    allow_all_repos: Boolean(options.allowAllRepos ?? config.allow_all_repos),
    workspace_root: options.workspaceRoot ?? config.workspace_root ?? ".git-runner/workspaces",
    job_store_root: options.jobStoreRoot ?? config.job_store_root ?? ".git-runner/jobs",
    cleanup: config.cleanup ?? { mode: "after_job" },
    once: Boolean(options.once)
  };
}

function validateWorkerStartup(workerConfig) {
  if (!workerConfig.worker_id) {
    throw new CliError("missing worker_id; provide --worker-id or worker config", EXIT_CODES.invalidUsage);
  }
  if (!workerConfig.worker_key) {
    throw new CliError("missing worker key; provide --worker-key or GIT_RUNNER_WORKER_KEY", EXIT_CODES.invalidUsage);
  }
  if (!workerConfig.tags.length) {
    throw new CliError("worker must have at least one tag", EXIT_CODES.invalidUsage);
  }
}

async function receiveLoop({ subscription, connection, workerConfig, options, workerState }) {
  for await (const message of subscription) {
    const jobSpec = JSON.parse(textDecoder.decode(message.data));
    await handleJob({ jobSpec, connection, workerConfig, options, workerState });
    if (workerConfig.once) {
      return;
    }
  }
}

async function handleJob({ jobSpec, connection, workerConfig, options, workerState }) {
  const startedAt = new Date().toISOString();
  let terminal;
  let executorSummary = null;
  let workspacePath = null;
  let reason = null;
  let artifacts = [];
  let cancelSubscription = null;
  workerState.status = "running";
  workerState.current_job_id = jobSpec.job_id ?? null;

  try {
    validateJob(jobSpec);
    validatePolicy(jobSpec, workerConfig);
    await writeJobSpec(jobStoreOptions(options, workerConfig, jobSpec.job_id, { jobSpec }));
    await writeAndPublishStatus({ connection, options, workerConfig, jobSpec, status: "RUNNING", reason: null });
    cancelSubscription = connection.subscribe(`git-runner.cancels.${jobSpec.job_id}`);

    workspacePath = await prepareWorkspace({ options, workerConfig, jobSpec });
    const requestPath = await writeExecutorRequest({ workspacePath, jobSpec });
    executorSummary = await runExecutorProcess({
      requestPath,
      timeoutSec: jobSpec.execution.timeout_sec,
      cancelSubscription
    });
    cancelSubscription.unsubscribe();
    reason = reasonFromExecutor(jobSpec, executorSummary);
    terminal = reason ? "FAILED" : "COMPLETED";
    artifacts = await collectArtifacts({ jobSpec, workspacePath, options, workerConfig });
  } catch (error) {
    reason = error.reason ?? "command_failed";
    terminal = reason === "cancelled" ? "CANCELLED" : "FAILED";
    executorSummary ??= emptyExecutorSummary(error.message);
    if (workspacePath) {
      artifacts = await collectArtifacts({ jobSpec, workspacePath, options, workerConfig }).catch(() => []);
    }
  } finally {
    cancelSubscription?.unsubscribe();
  }

  const sourceOutputDir = workspacePath ? path.join(workspacePath, ".git-runner") : null;
  if (sourceOutputDir) {
    await copyJobLogs({
      ...jobStoreBase(options, workerConfig),
      jobId: jobSpec.job_id,
      stdoutPath: path.join(sourceOutputDir, "stdout.log"),
      stderrPath: path.join(sourceOutputDir, "stderr.log")
    }).catch(() => {});
    await publishLogFile({ connection, jobId: jobSpec.job_id, stream: "stdout", filePath: path.join(sourceOutputDir, "stdout.log") }).catch(() => {});
    await publishLogFile({ connection, jobId: jobSpec.job_id, stream: "stderr", filePath: path.join(sourceOutputDir, "stderr.log") }).catch(() => {});
  }

  const summary = buildResultSummary({
    jobSpec,
    workerConfig,
    status: terminal,
    reason,
    startedAt,
    executorSummary,
    artifacts
  });
  await writeResultSummary({
    ...jobStoreBase(options, workerConfig),
    summary
  });
  await writeAndPublishStatus({ connection, options, workerConfig, jobSpec, status: terminal, reason });
  await publish(connection, `git-runner.results.${jobSpec.job_id}`, {
    schema_version: 1,
    event_type: "result",
    ...summary,
    timestamp: new Date().toISOString()
  });

  if (workspacePath && workerConfig.cleanup?.mode !== "never") {
    await cleanupWorkspace(workspacePath);
  }
  workerState.status = "idle";
  workerState.current_job_id = null;
}

async function cleanupWorkspace(workspacePath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(workspacePath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code) || attempt === 4) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

function validateJob(jobSpec) {
  if (jobSpec.schema_version !== 1) failJob("job_invalid", "unsupported schema_version");
  if (!jobSpec.job_id) failJob("job_invalid", "missing job_id");
  if (jobSpec.source?.type !== "git") failJob("job_invalid", "source.type must be git");
  if (!jobSpec.source?.repo) failJob("job_invalid", "missing source.repo");
  if (!jobSpec.source?.commit) failJob("job_invalid", "missing source.commit");
  if (jobSpec.entry?.type !== "command" || !jobSpec.entry.command) failJob("job_invalid", "entry command required");
  if (!jobSpec.params || Array.isArray(jobSpec.params) || typeof jobSpec.params !== "object") failJob("job_invalid", "params must be object");
  if (jobSpec.param_passing?.mode !== "json_file") failJob("job_invalid", "param_passing.mode must be json_file");
  validateRelativeContainedPath(jobSpec.working_dir, "working_dir");
  validateRelativeContainedPath(jobSpec.param_passing.path, "param_passing.path");
  validateRelativeContainedPath(jobSpec.outputs?.result?.path, "outputs.result.path");
  if (!["none", "json_schema"].includes(jobSpec.outputs?.result?.schema?.type)) failJob("job_invalid", "outputs.result.schema.type unsupported");
  if (jobSpec.outputs.result.schema.type === "json_schema") validateRelativeContainedPath(jobSpec.outputs.result.schema.file, "outputs.result.schema.file");
  for (const artifact of jobSpec.outputs?.artifacts ?? []) {
    validateRelativeContainedPath(artifact.path, "artifact.path");
  }
  if (jobSpec.runtime?.type !== "host") failJob("job_invalid", "runtime.type must be host");
  if (!Number.isInteger(jobSpec.execution?.timeout_sec) || jobSpec.execution.timeout_sec <= 0) failJob("job_invalid", "timeout_sec must be positive");
  if (!Number.isInteger(jobSpec.execution?.max_stdout_bytes) || jobSpec.execution.max_stdout_bytes <= 0) failJob("job_invalid", "max_stdout_bytes must be positive");
  if (!Number.isInteger(jobSpec.execution?.max_stderr_bytes) || jobSpec.execution.max_stderr_bytes <= 0) failJob("job_invalid", "max_stderr_bytes must be positive");
  for (const setup of jobSpec.setup ?? []) {
    if (setup.type !== "command" || !setup.command) failJob("job_invalid", "setup command invalid");
  }
}

function validateRelativeContainedPath(inputPath, label) {
  if (!inputPath || typeof inputPath !== "string") failJob("job_invalid", `${label} required`);
  if (path.isAbsolute(inputPath)) return;
  const normalized = path.normalize(inputPath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    failJob("job_invalid", `${label} escapes repository root`);
  }
}

function validatePolicy(jobSpec, workerConfig) {
  const routingTag = jobSpec.worker?.tags?.[0] ?? "default";
  if (!workerConfig.allowed_tags.includes(routingTag)) {
    failJob("worker_policy_denied", `tag not allowed: ${routingTag}`);
  }
  if (!workerConfig.allow_all_repos && !workerConfig.allowed_repos.includes(jobSpec.source.repo)) {
    failJob("worker_policy_denied", `repo not allowed: ${jobSpec.source.repo}`);
  }
  const controlledPaths = [
    jobSpec.working_dir,
    jobSpec.param_passing.path,
    jobSpec.outputs?.result?.path,
    jobSpec.outputs?.result?.schema?.file,
    ...(jobSpec.outputs?.artifacts ?? []).map((artifact) => artifact.path)
  ].filter(Boolean);
  for (const inputPath of controlledPaths) {
    if (path.isAbsolute(inputPath)) {
      failJob("worker_policy_denied", `absolute path denied: ${inputPath}`);
    }
  }
}

async function prepareWorkspace({ options, workerConfig, jobSpec }) {
  const workspaceRoot = resolvePath(options.cwd, workerConfig.workspace_root);
  const workspacePath = path.join(workspaceRoot, jobSpec.job_id);
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  try {
    await cloneRepository({ repo: jobSpec.source.repo, destination: workspacePath });
    await fetchRepository(workspacePath);
    await checkoutDetached({ repoRoot: workspacePath, commit: jobSpec.source.commit });
  } catch (error) {
    failJob("git_checkout_failed", error.message);
  }
  return workspacePath;
}

async function writeExecutorRequest({ workspacePath, jobSpec }) {
  const outputDir = path.join(workspacePath, ".git-runner");
  await mkdir(outputDir, { recursive: true });
  const request = {
    job_id: jobSpec.job_id,
    workspace_path: workspacePath,
    working_dir: jobSpec.working_dir,
    setup: jobSpec.setup,
    entry: jobSpec.entry,
    params: jobSpec.params,
    param_passing: jobSpec.param_passing,
    outputs: jobSpec.outputs,
    execution: jobSpec.execution
  };
  const requestPath = path.join(outputDir, "executor-request.json");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return requestPath;
}

function runExecutorProcess({ requestPath, timeoutSec, cancelSubscription }) {
  return new Promise((resolve, reject) => {
    const executorPath = fileURLToPath(new URL("../bin/git-runner-executor.js", import.meta.url));
    const child = spawn(process.execPath, [executorPath, requestPath], {
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(Object.assign(new Error("executor timed out"), { reason: "timeout" }));
    }, timeoutSec * 1000);
    (async () => {
      for await (const _message of cancelSubscription) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        killProcessTree(child);
        reject(Object.assign(new Error("job cancelled"), { reason: "cancelled" }));
        return;
      }
    })();
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancelSubscription.unsubscribe();
      if (code !== 0) {
        reject(Object.assign(new Error(`executor process failed with code ${code}`), { reason: "command_failed" }));
        return;
      }
      try {
        const summaryPath = path.join(path.dirname(requestPath), "executor-summary.json");
        resolve(JSON.parse(await readFile(summaryPath, "utf8")));
      } catch (error) {
        reject(Object.assign(error, { reason: "command_failed" }));
      }
    });
  });
}

function killProcessTree(child) {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
}

function reasonFromExecutor(jobSpec, summary) {
  const warningCodes = new Set((summary.result_warnings ?? []).map((warning) => warning.code));
  if (jobSpec.outputs.result.schema?.type === "json_schema") {
    if (warningCodes.has("result_missing")) return "result_missing";
    if (warningCodes.has("result_invalid")) return "result_invalid";
  }
  if (summary.exit_code !== 0 || summary.signal) {
    return "command_failed";
  }
  return null;
}

async function collectArtifacts({ jobSpec, workspacePath, options, workerConfig }) {
  const artifactSpecs = jobSpec.outputs?.artifacts ?? [];
  const copied = [];
  const jobDir = await ensureJobDir({
    ...jobStoreBase(options, workerConfig),
    jobId: jobSpec.job_id
  });
  const artifactStore = path.join(jobDir, "artifacts");
  await mkdir(artifactStore, { recursive: true });

  for (const artifact of artifactSpecs) {
    const metadata = {
      name: artifact.name,
      path: artifact.path,
      kind: artifact.kind ?? null,
      media_type: artifact.media_type ?? null
    };
    try {
      const sourcePath = resolveInside(workspacePath, artifact.path, "artifact path");
      const fileStat = await stat(sourcePath);
      if (!fileStat.isFile()) {
        copied.push({ ...metadata, missing: true, reason: "not_file" });
        continue;
      }
      const bytes = await readFile(sourcePath);
      const fileName = safeArtifactFileName(artifact.name ?? path.basename(artifact.path));
      await writeFile(path.join(artifactStore, fileName), bytes);
      copied.push({
        ...metadata,
        stored_path: path.join("artifacts", fileName),
        size_bytes: fileStat.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        missing: false
      });
    } catch (error) {
      copied.push({ ...metadata, missing: true, reason: error.code === "ENOENT" ? "missing" : error.message });
    }
  }

  return copied;
}

function safeArtifactFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "artifact";
}

function buildResultSummary({ jobSpec, workerConfig, status, reason, startedAt, executorSummary, artifacts }) {
  return {
    job_id: jobSpec.job_id,
    status,
    reason,
    worker_id: workerConfig.worker_id,
    source: jobSpec.source,
    exit_code: executorSummary.exit_code,
    signal: executorSummary.signal,
    duration_ms: executorSummary.duration_ms,
    stdout_bytes: executorSummary.stdout_bytes,
    stderr_bytes: executorSummary.stderr_bytes,
    stdout_truncated: executorSummary.stdout_truncated,
    stderr_truncated: executorSummary.stderr_truncated,
    result: executorSummary.result,
    result_warnings: executorSummary.result_warnings,
    artifacts,
    started_at: startedAt,
    finished_at: new Date().toISOString()
  };
}

async function writeAndPublishStatus({ connection, options, workerConfig, jobSpec, status, reason }) {
  const event = {
    schema_version: 1,
    event_type: "status",
    job_id: jobSpec.job_id,
    status,
    reason,
    worker_id: workerConfig.worker_id,
    timestamp: new Date().toISOString(),
    source: jobSpec.source
  };
  await writeJobStatus({
    ...jobStoreBase(options, workerConfig),
    status: event
  });
  await publish(connection, `git-runner.status.${jobSpec.job_id}`, event);
}

async function publish(connection, subject, payload) {
  connection.publish(subject, textEncoder.encode(JSON.stringify(payload)));
}

async function publishLogFile({ connection, jobId, stream, filePath }) {
  const data = await readFile(filePath, "utf8");
  await publish(connection, `git-runner.logs.${jobId}`, {
    schema_version: 1,
    event_type: "log",
    job_id: jobId,
    stream,
    data,
    encoding: "utf-8",
    offset: 0,
    timestamp: new Date().toISOString()
  });
}

function jobStoreBase(options, workerConfig) {
  return {
    cwd: options.cwd,
    configPath: options.configPath,
    jobStoreRoot: workerConfig.job_store_root,
    env: options.env
  };
}

function jobStoreOptions(options, workerConfig, jobId, extra) {
  return {
    ...jobStoreBase(options, workerConfig),
    jobId,
    ...extra
  };
}

function emptyExecutorSummary(message) {
  return {
    exit_code: 1,
    signal: null,
    duration_ms: 0,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    result: null,
    result_warnings: [{ code: "worker_error", message }]
  };
}

function failJob(reason, message) {
  throw Object.assign(new Error(message), { reason });
}

function splitCsv(input) {
  return input.split(",").map((item) => item.trim()).filter(Boolean);
}
