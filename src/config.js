import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError, EXIT_CODES } from "./errors.js";

export const DEFAULT_CONFIG_PATH = ".git-runner/config.json";
export const DEFAULT_WORKER_CONFIG_PATH = ".git-runner/worker.json";

export function defaultProjectConfig() {
  return {
    schema_version: 1,
    nats_url: "nats://localhost:4222",
    delivery_mode: "jetstream",
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
      artifacts: []
    },
    execution: {
      timeout_sec: 3600,
      max_stdout_bytes: 10485760,
      max_stderr_bytes: 10485760
    },
    job_store_root: ".git-runner/jobs"
  };
}

export function defaultWorkerConfig() {
  return {
    schema_version: 1,
    worker_id: null,
    tags: ["default"],
    allowed_tags: ["default"],
    allowed_repos: [],
    allow_all_repos: false,
    workspace_root: ".git-runner/workspaces",
    repo_cache_root: ".git-runner/repo-cache",
    job_store_root: ".git-runner/jobs",
    delivery_mode: "jetstream",
    cleanup: {
      mode: "after_job"
    }
  };
}

export function resolvePath(cwd, inputPath) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

export async function initProjectConfig({ cwd, configPath = DEFAULT_CONFIG_PATH }) {
  const absolutePath = resolvePath(cwd, configPath);
  const configDir = path.dirname(absolutePath);

  await mkdir(configDir, { recursive: true });

  let existed = false;
  try {
    await readFile(absolutePath, "utf8");
    existed = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new CliError(`cannot read config ${absolutePath}: ${error.message}`, EXIT_CODES.invalidUsage);
    }
  }

  if (!existed) {
    const content = `${JSON.stringify(defaultProjectConfig(), null, 2)}\n`;
    await writeFile(absolutePath, content, { flag: "wx" });
  }

  return {
    path: absolutePath,
    created: !existed
  };
}

export async function loadProjectConfig({ cwd, configPath = DEFAULT_CONFIG_PATH, env = {} }) {
  const absolutePath = resolvePath(cwd, configPath);
  let config = defaultProjectConfig();

  try {
    const raw = await readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.schema_version !== 1) {
      throw new CliError(`unsupported config schema_version in ${absolutePath}: ${parsed.schema_version}`, EXIT_CODES.invalidUsage);
    }
    config = {
      ...config,
      ...parsed,
      execution: {
        ...config.execution,
        ...(parsed.execution ?? {})
      },
      outputs: {
        ...config.outputs,
        ...(parsed.outputs ?? {})
      },
      param_passing: {
        ...config.param_passing,
        ...(parsed.param_passing ?? {})
      }
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      config = defaultProjectConfig();
    } else if (error instanceof SyntaxError) {
      throw new CliError(`invalid JSON in config ${absolutePath}: ${error.message}`, EXIT_CODES.invalidUsage);
    } else {
      throw error;
    }
  }

  if (env.GIT_RUNNER_NATS_URL) {
    config.nats_url = env.GIT_RUNNER_NATS_URL;
  }

  return {
    path: absolutePath,
    config
  };
}

export async function loadWorkerConfig({ cwd, configPath = DEFAULT_WORKER_CONFIG_PATH }) {
  const absolutePath = resolvePath(cwd, configPath);
  let config = defaultWorkerConfig();

  try {
    const raw = await readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.schema_version !== 1) {
      throw new CliError(`unsupported worker config schema_version in ${absolutePath}: ${parsed.schema_version}`, EXIT_CODES.invalidUsage);
    }
    config = {
      ...config,
      ...parsed,
      cleanup: {
        ...config.cleanup,
        ...(parsed.cleanup ?? {})
      }
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      config = defaultWorkerConfig();
    } else if (error instanceof SyntaxError) {
      throw new CliError(`invalid JSON in worker config ${absolutePath}: ${error.message}`, EXIT_CODES.invalidUsage);
    } else {
      throw error;
    }
  }

  return {
    path: absolutePath,
    config
  };
}
