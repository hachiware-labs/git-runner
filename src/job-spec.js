import { randomBytes } from "node:crypto";

export function createJobId() {
  return `job_${randomBytes(8).toString("hex")}`;
}

export function buildJobSpec({
  jobId,
  repo,
  branch,
  commit,
  command,
  workingDir,
  params,
  paramPassing,
  outputs,
  execution,
  workerTags
}) {
  return {
    schema_version: 1,
    job_id: jobId,
    source: {
      type: "git",
      repo,
      ...(branch ? { branch } : {}),
      commit
    },
    working_dir: workingDir,
    setup: [],
    entry: {
      type: "command",
      command
    },
    params,
    param_passing: paramPassing,
    outputs,
    execution,
    worker: {
      tags: workerTags
    },
    runtime: {
      type: "host"
    }
  };
}

export function subjectForJob(jobSpec) {
  const routingTag = jobSpec.worker.tags[0] ?? "default";
  return `git-runner.jobs.${routingTag}`;
}
