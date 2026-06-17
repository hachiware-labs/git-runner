import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { initProjectConfig, loadProjectConfig, resolvePath } from "./config.js";
import { CliError, EXIT_CODES, formatError } from "./errors.js";
import { commitAndPush, inspectRepository, isWorkingTreeDirty, resolveExecutionCommit } from "./git.js";
import { buildJobSpec, createJobId, subjectForJob } from "./job-spec.js";
import { readJobJson, readJobText, removeJobFromStore, writeSubmitJob } from "./job-store.js";
import { publishJob } from "./nats-publisher.js";
import { runWorker } from "./worker.js";

const HELP = `git-runner <command> [options]

Commands:
  init                 Create .git-runner/config.json
  submit               Resolve Git ref, build Job Spec, and publish it
  status <job-id>      Read .git-runner/jobs/<job-id>/status.json
  logs <job-id>        Read stdout/stderr logs from local job store
  get <job-id>         Read result-summary.json from local job store

Common options:
  --config <path>           Project config path
  --job-store-root <path>   Local job store root
  --json                    Print machine-readable JSON
  --help                    Show help
`;
const DEFAULT_ACCEPTED_STALE_AFTER_SEC = 60;

export async function main(argv, context) {
  try {
    const result = await run(argv, context);
    if (result !== undefined) {
      writeOutput(context.stdout, result);
    }
    return EXIT_CODES.success;
  } catch (error) {
    context.stderr.write(`${formatError(error)}\n`);
    return error instanceof CliError ? error.exitCode : EXIT_CODES.genericFailure;
  }
}

export async function run(argv, context) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return HELP;
  }

  const args = parseArgs(argv.slice(1));

  switch (command) {
    case "init":
      return commandInit(args, context);
    case "submit":
      return commandSubmit(args, context);
    case "status":
      return commandStatus(args, context);
    case "logs":
      return commandLogs(args, context);
    case "get":
      return commandGet(args, context);
    case "worker":
      return commandWorker(args, context);
    default:
      throw new CliError(`unknown command: ${command}\n\n${HELP}`, EXIT_CODES.invalidUsage);
  }
}

function parseArgs(argv) {
  const options = {
    positional: [],
    json: false,
    stdout: true,
    stderr: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        options.configPath = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--job-store-root":
        options.jobStoreRoot = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-require-worker":
        options.requireWorker = false;
        break;
      case "--repo":
        options.repo = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--command":
        options.command = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--branch":
        options.branch = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--commit":
        options.commit = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--commit-and-push":
        options.commitAndPush = true;
        break;
      case "--working-dir":
        options.workingDir = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--params":
        options.paramsPath = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--message":
        options.message = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--result-path":
        options.resultPath = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--result-schema":
        options.resultSchema = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--worker-tags":
        options.workerTags = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--timeout-sec":
        options.timeoutSec = Number(requireValue(argv, index, arg));
        index += 1;
        break;
      case "--stale-after-sec":
        options.staleAfterSec = Number(requireValue(argv, index, arg));
        index += 1;
        break;
      case "--nats-url":
        options.natsUrl = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--worker-id":
        options.workerId = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--worker-key":
        options.workerKey = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--tags":
        options.tags = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--allow-repo":
        options.allowRepos ??= [];
        options.allowRepos.push(requireValue(argv, index, arg));
        index += 1;
        break;
      case "--allow-all-repos":
        options.allowAllRepos = true;
        break;
      case "--workspace-root":
        options.workspaceRoot = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--once":
        options.once = true;
        break;
      case "--stdout":
        options.stdout = true;
        options.stderr = false;
        break;
      case "--stderr":
        options.stdout = false;
        options.stderr = true;
        break;
      case "--stream":
        options.stream = true;
        break;
      case "--output":
        options.outputDir = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new CliError(`unknown option: ${arg}`, EXIT_CODES.invalidUsage);
        }
        options.positional.push(arg);
        break;
    }
  }

  return options;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`missing value for ${optionName}`, EXIT_CODES.invalidUsage);
  }
  return value;
}

async function commandInit(args, context) {
  if (args.help) {
    return "git-runner init [--config .git-runner/config.json] [--json]\n";
  }
  const result = await initProjectConfig({
    cwd: context.cwd,
    configPath: args.configPath
  });

  if (args.json) {
    return result;
  }

  return result.created
    ? `created config: ${result.path}\n`
    : `config already exists: ${result.path}\n`;
}

async function commandSubmit(args, context) {
  if (args.help) {
    return "git-runner submit --command <command> [--repo .] [--branch name] [--commit sha] [--dry-run] [--no-require-worker] [--json]\n";
  }
  if (!args.command) {
    throw new CliError("missing required option: --command", EXIT_CODES.invalidUsage);
  }
  if (args.timeoutSec !== undefined && (!Number.isInteger(args.timeoutSec) || args.timeoutSec <= 0)) {
    throw new CliError("--timeout-sec must be a positive integer", EXIT_CODES.invalidUsage);
  }

  const { config } = await loadProjectConfig({
    cwd: context.cwd,
    configPath: args.configPath,
    env: context.env
  });
  const repoInput = args.repo ?? ".";
  const repoPath = resolvePath(context.cwd, repoInput);
  const repoRoot = await inspectRepository(repoPath);
  const jobId = createJobId();

  let branch = args.branch;
  if (args.commitAndPush) {
    branch = await commitAndPush({
      repoRoot,
      branch,
      message: args.message ?? `git-runner submit ${jobId}`
    });
  } else if (await isWorkingTreeDirty(repoRoot)) {
    context.stderr.write("warning: working tree has uncommitted changes; submit uses committed Git state only\n");
  }

  const commit = await resolveExecutionCommit({
    repoRoot,
    commit: args.commit,
    branch
  });
  const params = await loadParams({ cwd: context.cwd, paramsPath: args.paramsPath });
  const outputs = buildOutputs(config.outputs, args);
  const execution = {
    ...config.execution,
    ...(args.timeoutSec ? { timeout_sec: args.timeoutSec } : {})
  };
  const workerTags = parseTags(args.workerTags) ?? config.default_worker_tags ?? ["default"];
  const jobSpec = buildJobSpec({
    jobId,
    repo: repoRoot,
    branch,
    commit,
    command: args.command,
    workingDir: args.workingDir ?? ".",
    params,
    paramPassing: config.param_passing,
    outputs,
    execution,
    workerTags
  });
  const subject = subjectForJob(jobSpec);
  const natsUrl = args.natsUrl ?? config.nats_url;

  if (args.dryRun) {
    return formatSubmitResult({ args, jobSpec, subject, dryRun: true });
  }

  await writeSubmitJob({
    cwd: context.cwd,
    configPath: args.configPath,
    jobStoreRoot: args.jobStoreRoot,
    env: context.env,
    jobSpec
  });

  try {
    await publishJob({
      natsUrl,
      subject,
      jobSpec,
      requireWorker: args.requireWorker !== false
    });
  } catch (error) {
    await removeJobFromStore({
      cwd: context.cwd,
      configPath: args.configPath,
      jobStoreRoot: args.jobStoreRoot,
      env: context.env,
      jobId
    });
    throw error;
  }

  return formatSubmitResult({ args, jobSpec, subject, dryRun: false });
}

async function commandStatus(args, context) {
  if (args.help) {
    return "git-runner status <job-id> [--json] [--stale-after-sec 60] [--job-store-root .git-runner/jobs]\n";
  }
  if (args.staleAfterSec !== undefined && (!Number.isInteger(args.staleAfterSec) || args.staleAfterSec <= 0)) {
    throw new CliError("--stale-after-sec must be a positive integer", EXIT_CODES.invalidUsage);
  }
  const jobId = requireJobId(args);
  const result = await readJobJson({
    cwd: context.cwd,
    configPath: args.configPath,
    jobStoreRoot: args.jobStoreRoot,
    env: context.env,
    jobId,
    fileName: "status.json"
  });
  const status = annotateStatus(result.value, {
    staleAfterSec: args.staleAfterSec ?? DEFAULT_ACCEPTED_STALE_AFTER_SEC
  });

  return args.json ? status : formatStatus(status);
}

async function commandWorker(args, context) {
  if (args.help) {
    return "git-runner worker --worker-id <id> --worker-key <key> [--tags default] [--allow-repo repo] [--allow-all-repos] [--once]\n";
  }
  await runWorker({
    cwd: context.cwd,
    env: context.env,
    configPath: args.configPath,
    natsUrl: args.natsUrl,
    workerId: args.workerId,
    workerKey: args.workerKey,
    tags: args.tags,
    allowRepos: args.allowRepos,
    allowAllRepos: args.allowAllRepos,
    workspaceRoot: args.workspaceRoot,
    jobStoreRoot: args.jobStoreRoot,
    once: args.once
  });
  return args.once ? "worker processed one job\n" : undefined;
}

async function commandLogs(args, context) {
  if (args.help) {
    return "git-runner logs <job-id> [--stdout] [--stderr] [--job-store-root .git-runner/jobs]\n";
  }
  const jobId = requireJobId(args);
  const chunks = [];

  if (args.stdout) {
    const stdout = await readJobText({
      cwd: context.cwd,
      configPath: args.configPath,
      jobStoreRoot: args.jobStoreRoot,
      env: context.env,
      jobId,
      fileName: "stdout.log"
    });
    chunks.push(stdout.value);
  }

  if (args.stderr) {
    const stderr = await readJobText({
      cwd: context.cwd,
      configPath: args.configPath,
      jobStoreRoot: args.jobStoreRoot,
      env: context.env,
      jobId,
      fileName: "stderr.log"
    });
    chunks.push(stderr.value);
  }

  return chunks.join("");
}

async function commandGet(args, context) {
  if (args.help) {
    return "git-runner get <job-id> [--json] [--job-store-root .git-runner/jobs]\n";
  }
  const jobId = requireJobId(args);
  const result = await readJobJson({
    cwd: context.cwd,
    configPath: args.configPath,
    jobStoreRoot: args.jobStoreRoot,
    env: context.env,
    jobId,
    fileName: "result-summary.json"
  });

  if (args.outputDir) {
    await copyArtifactsToOutput({
      result: result.value,
      jobStoreResultPath: result.path,
      outputDir: resolvePath(context.cwd, args.outputDir)
    });
  }

  return args.json ? result.value : JSON.stringify(result.value, null, 2);
}

function requireJobId(args) {
  const jobId = args.positional[0];
  if (!jobId) {
    throw new CliError("missing job id", EXIT_CODES.invalidUsage);
  }
  return jobId;
}

async function loadParams({ cwd, paramsPath }) {
  if (!paramsPath) {
    return {};
  }
  const absolutePath = resolvePath(cwd, paramsPath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`invalid JSON params file ${absolutePath}: ${error.message}`, EXIT_CODES.invalidUsage);
    }
    throw new CliError(`cannot read params file ${absolutePath}: ${error.message}`, EXIT_CODES.invalidUsage);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new CliError(`params file must contain a JSON object: ${absolutePath}`, EXIT_CODES.invalidUsage);
  }
  return parsed;
}

function buildOutputs(configOutputs, args) {
  const result = {
    ...(configOutputs?.result ?? {
      path: ".git-runner/result.json",
      schema: { type: "none" }
    })
  };
  if (args.resultPath) {
    result.path = args.resultPath;
  }
  if (args.resultSchema) {
    result.schema = {
      type: "json_schema",
      file: args.resultSchema
    };
  }
  return {
    result,
    artifacts: configOutputs?.artifacts ?? []
  };
}

function parseTags(input) {
  if (!input) {
    return null;
  }
  const tags = input.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (tags.length === 0) {
    throw new CliError("--worker-tags must include at least one tag", EXIT_CODES.invalidUsage);
  }
  return tags;
}

function formatSubmitResult({ args, jobSpec, subject, dryRun }) {
  const result = {
    job_id: jobSpec.job_id,
    commit: jobSpec.source.commit,
    subject,
    ...(dryRun ? { dry_run: true, job_spec: jobSpec } : {})
  };
  if (args.json) {
    return result;
  }
  if (dryRun) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return `job_id: ${result.job_id}\ncommit: ${result.commit}\nsubject: ${result.subject}\n`;
}

async function copyArtifactsToOutput({ result, jobStoreResultPath, outputDir }) {
  const jobDir = path.dirname(jobStoreResultPath);
  await mkdir(outputDir, { recursive: true });
  for (const artifact of result.artifacts ?? []) {
    if (artifact.missing || !artifact.stored_path) {
      continue;
    }
    const source = path.resolve(jobDir, artifact.stored_path);
    const destinationName = path.basename(artifact.stored_path);
    await copyFile(source, path.join(outputDir, destinationName));
  }
}

function formatStatus(status) {
  const lines = [
    `job_id: ${status.job_id ?? ""}`,
    `status: ${status.status ?? ""}`,
    `reason: ${status.reason ?? ""}`,
    `worker_id: ${status.worker_id ?? ""}`
  ];

  if (status.source?.commit) {
    lines.push(`commit: ${status.source.commit}`);
  }
  if (status.started_at) {
    lines.push(`started_at: ${status.started_at}`);
  }
  if (status.updated_at) {
    lines.push(`updated_at: ${status.updated_at}`);
  }
  if (typeof status.stale === "boolean") {
    lines.push(`stale: ${status.stale}`);
  }
  if (status.age_sec !== undefined) {
    lines.push(`age_sec: ${status.age_sec}`);
  }
  if (status.stale_after_sec !== undefined) {
    lines.push(`stale_after_sec: ${status.stale_after_sec}`);
  }

  return `${lines.join("\n")}\n`;
}

function annotateStatus(status, { staleAfterSec }) {
  if (status.status !== "ACCEPTED" || !status.timestamp) {
    return status;
  }
  const timestampMs = Date.parse(status.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return status;
  }
  const ageSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  return {
    ...status,
    stale: ageSec >= staleAfterSec,
    age_sec: ageSec,
    stale_after_sec: staleAfterSec
  };
}

function writeOutput(stream, value) {
  if (typeof value === "string") {
    stream.write(value);
    return;
  }
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
