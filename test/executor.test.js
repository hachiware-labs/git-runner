import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runExecutor } from "../src/executor.js";

async function tempWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), "git-runner-executor-"));
}

function baseRequest(workspacePath, command) {
  return {
    job_id: "job_exec",
    workspace_path: workspacePath,
    working_dir: ".",
    setup: [],
    entry: {
      type: "command",
      command
    },
    params: { value: 1 },
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
    }
  };
}

test("executor writes params, captures logs, and reads optional result JSON", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "run.js"), [
    "const fs = require('fs');",
    "fs.mkdirSync('.git-runner', { recursive: true });",
    "const params = JSON.parse(fs.readFileSync('.git-runner/params.json', 'utf8'));",
    "fs.writeFileSync('.git-runner/result.json', JSON.stringify({ value: params.params.value }));",
    "console.log('hello');",
    ""
  ].join("\n"));

  const summary = await runExecutor(baseRequest(workspace, "node run.js"));

  assert.equal(summary.exit_code, 0);
  assert.deepEqual(summary.result, { value: 1 });
  assert.deepEqual(summary.result_warnings, []);
  assert.equal(await readFile(path.join(workspace, ".git-runner", "stdout.log"), "utf8"), "hello\n");
});

test("executor records result_invalid warning for JSON schema failure", async () => {
  const workspace = await tempWorkspace();
  await mkdir(path.join(workspace, "schemas"), { recursive: true });
  await writeFile(path.join(workspace, "schemas", "result.schema.json"), `${JSON.stringify({
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean" }
    }
  })}\n`);
  await writeFile(path.join(workspace, "run.js"), [
    "const fs = require('fs');",
    "fs.mkdirSync('.git-runner', { recursive: true });",
    "fs.writeFileSync('.git-runner/result.json', JSON.stringify({ ok: 'no' }));",
    ""
  ].join("\n"));

  const request = baseRequest(workspace, "node run.js");
  request.outputs.result.schema = {
    type: "json_schema",
    file: "schemas/result.schema.json"
  };

  const summary = await runExecutor(request);

  assert.equal(summary.exit_code, 0);
  assert.equal(summary.result_warnings[0].code, "result_invalid");
});
