import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import Ajv from "ajv";
import { resolveInside } from "./path-utils.js";

export async function runExecutorCli(argv) {
  const requestPath = argv[0];
  if (!requestPath) {
    process.stderr.write("missing executor request path\n");
    return 2;
  }

  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const summary = await runExecutor(request);
  await writeFile(resolveInside(request.workspace_path, ".git-runner/executor-summary.json", "executor summary path"), `${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

export async function runExecutor(request) {
  const start = Date.now();
  const outputDir = resolveInside(request.workspace_path, ".git-runner", "output directory");
  await mkdir(outputDir, { recursive: true });

  const stdoutPath = path.join(outputDir, "stdout.log");
  const stderrPath = path.join(outputDir, "stderr.log");
  await writeFile(stdoutPath, "");
  await writeFile(stderrPath, "");

  const paramsPath = resolveInside(request.workspace_path, request.param_passing.path, "params path");
  await mkdir(path.dirname(paramsPath), { recursive: true });
  await writeFile(paramsPath, `${JSON.stringify({ job_id: request.job_id, params: request.params }, null, 2)}\n`);

  let exitCode = 0;
  let signal = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let failedStage = null;
  const cwd = resolveInside(request.workspace_path, request.working_dir, "working_dir");

  const run = async (command) => {
    const result = await runCommand({
      command,
      cwd,
      stdoutPath,
      stderrPath,
      stdoutBytes,
      stderrBytes,
      maxStdoutBytes: request.execution.max_stdout_bytes,
      maxStderrBytes: request.execution.max_stderr_bytes
    });
    stdoutBytes = result.stdoutBytes;
    stderrBytes = result.stderrBytes;
    stdoutTruncated ||= result.stdoutTruncated;
    stderrTruncated ||= result.stderrTruncated;
    return result;
  };

  for (const setup of request.setup ?? []) {
    const result = await run(setup.command);
    if (result.exitCode !== 0 || result.signal) {
      exitCode = result.exitCode;
      signal = result.signal;
      failedStage = "setup";
      break;
    }
  }

  if (exitCode === 0 && !signal) {
    const result = await run(request.entry.command);
    exitCode = result.exitCode;
    signal = result.signal;
    if (result.exitCode !== 0 || result.signal) {
      failedStage = "entry";
    }
  }

  const resultData = await readResult({
    workspacePath: request.workspace_path,
    resultConfig: request.outputs.result
  });

  return {
    exit_code: exitCode,
    signal,
    duration_ms: Date.now() - start,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    failed_stage: failedStage,
    ...resultData
  };
}

function runCommand({ command, cwd, stdoutPath, stderrPath, stdoutBytes, stderrBytes, maxStdoutBytes, maxStderrBytes }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true
    });
    const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
    const stderrStream = createWriteStream(stderrPath, { flags: "a" });
    let nextStdoutBytes = stdoutBytes;
    let nextStderrBytes = stderrBytes;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout.on("data", (chunk) => {
      const write = truncateChunk(chunk, nextStdoutBytes, maxStdoutBytes);
      nextStdoutBytes += chunk.length;
      stdoutTruncated ||= write.length < chunk.length;
      if (write.length > 0) {
        stdoutStream.write(write);
      }
    });
    child.stderr.on("data", (chunk) => {
      const write = truncateChunk(chunk, nextStderrBytes, maxStderrBytes);
      nextStderrBytes += chunk.length;
      stderrTruncated ||= write.length < chunk.length;
      if (write.length > 0) {
        stderrStream.write(write);
      }
    });
    child.on("close", (code, signal) => {
      stdoutStream.end(() => {
        stderrStream.end(() => {
          resolve({
            exitCode: code ?? 1,
            signal,
            stdoutBytes: Math.min(nextStdoutBytes, maxStdoutBytes),
            stderrBytes: Math.min(nextStderrBytes, maxStderrBytes),
            stdoutTruncated,
            stderrTruncated
          });
        });
      });
    });
  });
}

function truncateChunk(chunk, currentBytes, maxBytes) {
  if (currentBytes >= maxBytes) {
    return Buffer.alloc(0);
  }
  const remaining = maxBytes - currentBytes;
  return chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
}

async function readResult({ workspacePath, resultConfig }) {
  const resultWarnings = [];
  const resultPath = resolveInside(workspacePath, resultConfig.path, "result path");
  let raw;
  try {
    raw = await readFile(resultPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        result: null,
        result_warnings: resultConfig.schema?.type === "none" ? [] : [{ code: "result_missing" }]
      };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (resultConfig.schema?.type === "json_schema") {
      const schemaPath = resolveInside(workspacePath, resultConfig.schema.file, "result schema path");
      const schema = JSON.parse(await readFile(schemaPath, "utf8"));
      const ajv = new Ajv();
      const validate = ajv.compile(schema);
      if (!validate(parsed)) {
        return {
          result: parsed,
          result_warnings: [{ code: "result_invalid", errors: validate.errors }]
        };
      }
    }
    return {
      result: parsed,
      result_warnings: resultWarnings
    };
  } catch (error) {
    if (resultConfig.schema?.type === "none") {
      return {
        result: null,
        result_warnings: [{ code: "optional_result_invalid_json", message: error.message }]
      };
    }
    return {
      result: null,
      result_warnings: [{ code: "result_invalid", message: error.message }]
    };
  }
}
