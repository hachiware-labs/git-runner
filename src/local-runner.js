import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT_CODES } from "./errors.js";
import { resolveInside } from "./path-utils.js";

const DEFAULT_BUNDLE_PATH = ".git-runner/result-bundle.json";
const DEFAULT_WORKER_ID = "local-001";

export async function runLocalJob({ cwd, jobPath, workspace = ".", bundlePath = DEFAULT_BUNDLE_PATH, workerId = DEFAULT_WORKER_ID }) {
  if (!jobPath) {
    throw new CliError("missing job json path", EXIT_CODES.invalidUsage);
  }
  const workspacePath = path.resolve(cwd, workspace);
  await ensureDirectory(workspacePath, "--workspace");

  const bundleFile = path.isAbsolute(bundlePath)
    ? bundlePath
    : path.resolve(workspacePath, bundlePath);
  const submittedAt = new Date().toISOString();

  let jobSpec;
  try {
    const jobFile = path.isAbsolute(jobPath) ? jobPath : path.resolve(workspacePath, jobPath);
    jobSpec = normalizeJobSpec(JSON.parse(await readFile(jobFile, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`invalid job JSON: ${error.message}`, EXIT_CODES.invalidUsage);
    }
    if (error instanceof CliError) {
      const bundle = failureBundle({
        jobSpec: null,
        workerId,
        submittedAt,
        startedAt: submittedAt,
        finishedAt: new Date().toISOString(),
        reason: "invalid_job_spec",
        message: error.message
      });
      await writeBundle(bundleFile, bundle);
      return { bundle, bundlePath: bundleFile, exitCode: EXIT_CODES.genericFailure };
    }
    throw new CliError(`cannot read job JSON: ${error.message}`, EXIT_CODES.invalidUsage);
  }

  const startedAt = new Date().toISOString();
  let executorSummary = null;
  let reason = null;
  let status = "COMPLETED";
  let artifacts = [];
  let errorMessage = null;

  try {
    const requestPath = await writeExecutorRequest({ workspacePath, jobSpec });
    executorSummary = await runExecutorProcess({
      requestPath,
      timeoutSec: jobSpec.execution.timeout_sec
    });
    reason = reasonFromExecutor(jobSpec, executorSummary);
    artifacts = await collectArtifacts({ jobSpec, workspacePath });
    if (!reason && artifacts.some((artifact) => artifact.required && artifact.missing)) {
      reason = "artifact_missing";
    }
    status = reason ? "FAILED" : "COMPLETED";
  } catch (error) {
    reason = error.reason ?? (error instanceof CliError ? "invalid_job_spec" : "command_failed");
    status = reason === "cancelled" ? "CANCELLED" : "FAILED";
    errorMessage = error.message;
    executorSummary = emptyExecutorSummary(error.message);
    artifacts = await collectArtifacts({ jobSpec, workspacePath }).catch(() => []);
  }

  const finishedAt = new Date().toISOString();
  const bundle = buildResultBundle({
    jobSpec,
    workerId,
    status,
    reason,
    submittedAt,
    startedAt,
    finishedAt,
    executorSummary,
    artifacts,
    errorMessage
  });
  await writeBundle(bundleFile, bundle);
  return {
    bundle,
    bundlePath: bundleFile,
    exitCode: status === "COMPLETED" ? EXIT_CODES.success : EXIT_CODES.genericFailure
  };
}

async function ensureDirectory(directoryPath, label) {
  let metadata;
  try {
    metadata = await stat(directoryPath);
  } catch (error) {
    throw new CliError(`${label} does not exist: ${directoryPath}`, EXIT_CODES.invalidUsage);
  }
  if (!metadata.isDirectory()) {
    throw new CliError(`${label} must be a directory: ${directoryPath}`, EXIT_CODES.invalidUsage);
  }
}

function normalizeJobSpec(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new CliError("job spec must be a JSON object", EXIT_CODES.invalidUsage);
  }
  if (input.schema_version !== 1) failInvalid("unsupported schema_version");
  if (!input.job_id || typeof input.job_id !== "string") failInvalid("missing job_id");
  if (input.source?.type !== "git") failInvalid("source.type must be git");
  if (!input.source?.repo) failInvalid("missing source.repo");
  if (!input.source?.commit) failInvalid("missing source.commit");
  if (input.entry?.type !== "command" || !input.entry.command) failInvalid("entry command required");
  if (!input.params || Array.isArray(input.params) || typeof input.params !== "object") failInvalid("params must be object");
  if (input.param_passing?.mode !== "json_file") failInvalid("param_passing.mode must be json_file");
  if (!["none", "json_schema"].includes(input.outputs?.result?.schema?.type)) failInvalid("outputs.result.schema.type unsupported");
  if ((input.runtime ?? { type: "host" }).type !== "host") failInvalid("runtime.type must be host");
  validateExecution(input.execution);

  const setup = normalizeSetup(input.setup ?? []);
  const routingTag = input.worker?.routing_tag ?? input.worker?.tags?.[0] ?? "default";
  if (typeof routingTag !== "string" || !routingTag) failInvalid("worker routing tag invalid");

  return {
    ...input,
    working_dir: input.working_dir ?? ".",
    setup,
    worker: {
      ...(input.worker ?? {}),
      routing_tag: routingTag,
      tags: input.worker?.tags ?? [routingTag]
    },
    runtime: input.runtime ?? { type: "host" }
  };
}

function normalizeSetup(setup) {
  if (!Array.isArray(setup)) failInvalid("setup must be an array");
  return setup.map((entry) => {
    if (typeof entry === "string") {
      if (!entry.trim()) failInvalid("setup command invalid");
      return { type: "command", command: entry };
    }
    if (entry?.type === "command" && typeof entry.command === "string" && entry.command.trim()) {
      return { type: "command", command: entry.command };
    }
    failInvalid("setup command invalid");
  });
}

function validateExecution(execution) {
  if (!Number.isInteger(execution?.timeout_sec) || execution.timeout_sec <= 0) failInvalid("timeout_sec must be positive");
  if (!Number.isInteger(execution?.max_stdout_bytes) || execution.max_stdout_bytes <= 0) failInvalid("max_stdout_bytes must be positive");
  if (!Number.isInteger(execution?.max_stderr_bytes) || execution.max_stderr_bytes <= 0) failInvalid("max_stderr_bytes must be positive");
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
  const requestPath = path.join(outputDir, "local-executor-request.json");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return requestPath;
}

function runExecutorProcess({ requestPath, timeoutSec }) {
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
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
  if (summary.failed_stage === "setup") {
    return "setup_failed";
  }
  if (summary.exit_code !== 0 || summary.signal) {
    return "command_failed";
  }
  return null;
}

async function collectArtifacts({ jobSpec, workspacePath }) {
  const artifacts = [];
  for (const artifact of jobSpec.outputs?.artifacts ?? []) {
    const metadata = {
      name: artifact.name,
      path: artifact.path,
      kind: artifact.kind ?? null,
      media_type: artifact.media_type ?? null,
      required: Boolean(artifact.required)
    };
    try {
      const sourcePath = resolveInside(workspacePath, artifact.path, "artifact path");
      const fileStat = await stat(sourcePath);
      if (!fileStat.isFile()) {
        artifacts.push({ ...metadata, file: null, bytes: 0, missing: true, reason: "not_file" });
        continue;
      }
      const bytes = await readFile(sourcePath);
      artifacts.push({
        ...metadata,
        file: toWorkspaceRelative(workspacePath, sourcePath),
        bytes: fileStat.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        missing: false
      });
    } catch (error) {
      artifacts.push({
        ...metadata,
        file: null,
        bytes: 0,
        missing: true,
        reason: error.code === "ENOENT" ? "missing" : error.message
      });
    }
  }
  return artifacts;
}

function buildResultBundle({ jobSpec, workerId, status, reason, submittedAt, startedAt, finishedAt, executorSummary, artifacts, errorMessage }) {
  return {
    schema_version: "git-runner.result-bundle.v1",
    job_id: jobSpec.job_id,
    status,
    reason,
    job: jobSpec,
    source: jobSpec.source,
    worker: {
      worker_id: workerId,
      routing_tag: jobSpec.worker.routing_tag
    },
    timing: {
      submitted_at: submittedAt,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: executorSummary.duration_ms
    },
    execution: {
      exit_code: executorSummary.exit_code,
      signal: executorSummary.signal,
      timed_out: reason === "timeout",
      failed_stage: executorSummary.failed_stage,
      commands: [
        ...(jobSpec.setup ?? []).map((setup) => setup.command),
        jobSpec.entry.command
      ]
    },
    outputs: {
      stdout: {
        file: ".git-runner/stdout.log",
        bytes: executorSummary.stdout_bytes,
        truncated: executorSummary.stdout_truncated
      },
      stderr: {
        file: ".git-runner/stderr.log",
        bytes: executorSummary.stderr_bytes,
        truncated: executorSummary.stderr_truncated
      },
      result: {
        path: jobSpec.outputs.result.path,
        schema: jobSpec.outputs.result.schema,
        file: executorSummary.result === null ? null : jobSpec.outputs.result.path,
        value: executorSummary.result,
        warnings: executorSummary.result_warnings ?? []
      },
      artifacts
    },
    error: reason ? {
      status,
      reason,
      message: errorMessage ?? messageForReason(reason),
      retryable: reason === "timeout" || reason === "command_failed",
      emitted_by: "git-runner local run",
      details: executorSummary.result_warnings ?? []
    } : null
  };
}

function failureBundle({ jobSpec, workerId, submittedAt, startedAt, finishedAt, reason, message }) {
  const summary = emptyExecutorSummary(message);
  const fallbackJob = jobSpec ?? {
    job_id: null,
    source: {},
    worker: { routing_tag: "default" },
    outputs: {
      result: {
        path: null,
        schema: { type: "none" }
      },
      artifacts: []
    },
    setup: [],
    entry: { command: "" }
  };
  return buildResultBundle({
    jobSpec: fallbackJob,
    workerId,
    status: "FAILED",
    reason,
    submittedAt,
    startedAt,
    finishedAt,
    executorSummary: summary,
    artifacts: [],
    errorMessage: message
  });
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
    failed_stage: null,
    result: null,
    result_warnings: [{ code: "local_run_error", message }]
  };
}

async function writeBundle(bundlePath, bundle) {
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
}

function messageForReason(reason) {
  switch (reason) {
    case "result_missing":
      return "required result JSON was not produced";
    case "result_invalid":
      return "result JSON failed validation";
    case "artifact_missing":
      return "required artifact was not produced";
    case "timeout":
      return "job timed out";
    case "setup_failed":
      return "setup command exited unsuccessfully";
    case "command_failed":
      return "command exited unsuccessfully";
    default:
      return reason;
  }
}

function toWorkspaceRelative(workspacePath, filePath) {
  return path.relative(workspacePath, filePath).split(path.sep).join("/");
}

function failInvalid(message) {
  throw new CliError(message, EXIT_CODES.invalidUsage);
}
