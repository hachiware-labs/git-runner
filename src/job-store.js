import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, resolvePath } from "./config.js";
import { CliError, EXIT_CODES } from "./errors.js";

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

export async function removeJobFromStore({ cwd, configPath, jobStoreRoot, env, jobId }) {
  const storeRoot = await resolveJobStore({ cwd, configPath, jobStoreRoot, env });
  const jobDir = path.join(storeRoot, jobId);
  await rm(jobDir, { recursive: true, force: true });
}
