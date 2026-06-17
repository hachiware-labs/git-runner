import { readFile } from "node:fs/promises";
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
