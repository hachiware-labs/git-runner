import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, resolvePath } from "./config.js";
import { CliError, EXIT_CODES } from "./errors.js";

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export async function resolveJobStore({ cwd, configPath, jobStoreRoot, env }) {
  if (jobStoreRoot) {
    return resolvePath(cwd, jobStoreRoot);
  }

  const { config } = await loadProjectConfig({ cwd, configPath, env });
  return resolvePath(cwd, config.job_store_root ?? ".git-runner/jobs");
}

export function resolveJobPath(jobStoreRoot, jobId, fileName) {
  if (!jobId || jobId.includes("/") || jobId.includes("\\") || jobId === "." || jobId === "..") {
    throw new CliError(`invalid job id: ${jobId ?? ""}`, EXIT_CODES.invalidUsage);
  }
  return path.join(jobStoreRoot, jobId, fileName);
}

export async function readJobJson({ cwd, configPath, jobStoreRoot, env, jobId, fileName }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const filePath = resolveJobPath(storeRoot, jobId, fileName);

  try {
    const raw = await readFile(filePath, "utf8");
    return {
      path: filePath,
      value: JSON.parse(raw)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new CliError(`job not found in local job store: ${jobId} (${filePath})`, EXIT_CODES.jobStoreFailure);
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`invalid JSON in job store file ${filePath}: ${error.message}`, EXIT_CODES.jobStoreFailure);
    }
    throw new CliError(`cannot read job store file ${filePath}: ${error.message}`, EXIT_CODES.jobStoreFailure);
  }
}

export async function readJobJsonIfExists({ cwd, configPath, jobStoreRoot, env, jobId, fileName }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const filePath = resolveJobPath(storeRoot, jobId, fileName);

  try {
    const raw = await readFile(filePath, "utf8");
    return {
      path: filePath,
      value: JSON.parse(raw)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`invalid JSON in job store file ${filePath}: ${error.message}`, EXIT_CODES.jobStoreFailure);
    }
    throw new CliError(`cannot read job store file ${filePath}: ${error.message}`, EXIT_CODES.jobStoreFailure);
  }
}

export async function readJobText({ cwd, configPath, jobStoreRoot, env, jobId, fileName }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const filePath = resolveJobPath(storeRoot, jobId, fileName);

  try {
    return {
      path: filePath,
      value: await readFile(filePath, "utf8")
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new CliError(`job log not found in local job store: ${jobId} (${filePath})`, EXIT_CODES.jobStoreFailure);
    }
    throw new CliError(`cannot read job log ${filePath}: ${error.message}`, EXIT_CODES.jobStoreFailure);
  }
}

export async function readJobExecutionLock({ cwd, configPath, jobStoreRoot, env, jobId }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const lockDir = resolveJobPath(storeRoot, jobId, "execution.lock");
  const ownerPath = path.join(lockDir, "owner.json");

  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    return {
      present: true,
      path: lockDir,
      owner
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        return {
          present: true,
          path: lockDir,
          owner: null,
          error: `invalid owner.json: ${error.message}`
        };
      }
      throw new CliError(`cannot read job execution lock ${ownerPath}: ${error.message}`, EXIT_CODES.jobStoreFailure);
    }
  }

  try {
    await stat(lockDir);
    return {
      present: true,
      path: lockDir,
      owner: null,
      error: "owner.json missing"
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new CliError(`cannot inspect job execution lock ${lockDir}: ${error.message}`, EXIT_CODES.jobStoreFailure);
  }
}

export async function writeSubmitJob({ cwd, configPath, jobStoreRoot, env, jobSpec }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const jobDir = path.join(storeRoot, jobSpec.job_id);
  const now = new Date().toISOString();
  const status = {
    schema_version: 1,
    event_type: "status",
    job_id: jobSpec.job_id,
    status: "PENDING",
    reason: null,
    worker_id: null,
    timestamp: now,
    source: jobSpec.source
  };

  try {
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, "job-spec.json"), `${JSON.stringify(jobSpec, null, 2)}\n`, { flag: "wx" });
    await writeFile(path.join(jobDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    throw new CliError(`cannot write local job store for ${jobSpec.job_id}: ${error.message}`, EXIT_CODES.jobStoreFailure);
  }

  return {
    jobDir,
    status
  };
}

export async function ensureJobDir({ cwd, configPath, jobStoreRoot, env, jobId }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const jobDir = path.join(storeRoot, jobId);
  await mkdir(jobDir, { recursive: true });
  return jobDir;
}

export async function writeJobStatus({ cwd, configPath, jobStoreRoot, env, status }) {
  const jobDir = await ensureJobDir({ cwd, configPath, jobStoreRoot, env, jobId: status.job_id });
  await writeFile(path.join(jobDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  return path.join(jobDir, "status.json");
}

export async function writeJobSpec({ cwd, configPath, jobStoreRoot, env, jobSpec }) {
  const jobDir = await ensureJobDir({ cwd, configPath, jobStoreRoot, env, jobId: jobSpec.job_id });
  await writeFile(path.join(jobDir, "job-spec.json"), `${JSON.stringify(jobSpec, null, 2)}\n`);
  return path.join(jobDir, "job-spec.json");
}

export async function writeResultSummary({ cwd, configPath, jobStoreRoot, env, summary }) {
  const jobDir = await ensureJobDir({ cwd, configPath, jobStoreRoot, env, jobId: summary.job_id });
  await writeFile(path.join(jobDir, "result-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return path.join(jobDir, "result-summary.json");
}

export async function acquireJobExecutionLock({ cwd, configPath, jobStoreRoot, env, jobId, workerId }) {
  const jobDir = await ensureJobDir({ cwd, configPath, jobStoreRoot, env, jobId });
  const terminalSummary = await readTerminalResultSummary(jobDir);
  if (terminalSummary) {
    return { acquired: false, reason: "terminal", summary: terminalSummary };
  }

  const lockDir = path.join(jobDir, "execution.lock");
  try {
    await mkdir(lockDir);
    try {
      await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
        schema_version: 1,
        job_id: jobId,
        worker_id: workerId,
        pid: process.pid,
        acquired_at: new Date().toISOString()
      }, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true });
      throw error;
    }
    return {
      acquired: true,
      lock: { lockDir }
    };
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw new CliError(`cannot acquire job execution lock for ${jobId}: ${error.message}`, EXIT_CODES.jobStoreFailure);
    }
    const summaryAfterConflict = await readTerminalResultSummary(jobDir);
    if (summaryAfterConflict) {
      return { acquired: false, reason: "terminal", summary: summaryAfterConflict };
    }
    return { acquired: false, reason: "locked", lockDir };
  }
}

export async function releaseJobExecutionLock(lock) {
  if (!lock?.lockDir) {
    return;
  }
  await rm(lock.lockDir, { recursive: true, force: true });
}

export async function copyJobLogs({ cwd, configPath, jobStoreRoot, env, jobId, stdoutPath, stderrPath }) {
  const jobDir = await ensureJobDir({ cwd, configPath, jobStoreRoot, env, jobId });
  await copyFile(stdoutPath, path.join(jobDir, "stdout.log"));
  await copyFile(stderrPath, path.join(jobDir, "stderr.log"));
}

export async function removeJobFromStore({ cwd, configPath, jobStoreRoot, env, jobId }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const jobDir = path.join(storeRoot, jobId);
  await rm(jobDir, { recursive: true, force: true });
}

async function readTerminalResultSummary(jobDir) {
  try {
    const summary = JSON.parse(await readFile(path.join(jobDir, "result-summary.json"), "utf8"));
    return TERMINAL_STATUSES.has(summary.status) ? summary : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`invalid JSON in job result summary ${jobDir}: ${error.message}`, EXIT_CODES.jobStoreFailure);
    }
    throw new CliError(`cannot read job result summary ${jobDir}: ${error.message}`, EXIT_CODES.jobStoreFailure);
  }
}
