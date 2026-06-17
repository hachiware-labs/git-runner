import { initProjectConfig } from "./config.js";
import { CliError, EXIT_CODES, formatError } from "./errors.js";
import { readJobJson, readJobText } from "./job-store.js";

const HELP = `git-runner <command> [options]

Commands:
  init                 Create .git-runner/config.json
  status <job-id>      Read .git-runner/jobs/<job-id>/status.json
  logs <job-id>        Read stdout/stderr logs from local job store
  get <job-id>         Read result-summary.json from local job store

Common options:
  --config <path>           Project config path
  --job-store-root <path>   Local job store root
  --json                    Print machine-readable JSON
  --help                    Show help
`;

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
    case "status":
      return commandStatus(args, context);
    case "logs":
      return commandLogs(args, context);
    case "get":
      return commandGet(args, context);
    case "submit":
    case "worker":
      throw new CliError(`${command} is not implemented in this vertical slice`, EXIT_CODES.invalidUsage);
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
      case "--stdout":
        options.stdout = true;
        options.stderr = false;
        break;
      case "--stderr":
        options.stdout = false;
        options.stderr = true;
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

async function commandStatus(args, context) {
  if (args.help) {
    return "git-runner status <job-id> [--json] [--job-store-root .git-runner/jobs]\n";
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

  return args.json ? result.value : formatStatus(result.value);
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

  return args.json ? result.value : JSON.stringify(result.value, null, 2);
}

function requireJobId(args) {
  const jobId = args.positional[0];
  if (!jobId) {
    throw new CliError("missing job id", EXIT_CODES.invalidUsage);
  }
  return jobId;
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

  return `${lines.join("\n")}\n`;
}

function writeOutput(stream, value) {
  if (typeof value === "string") {
    stream.write(value);
    return;
  }
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
