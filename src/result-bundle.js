import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError, EXIT_CODES } from "./errors.js";
import { assertResultBundle } from "./result-bundle-validator.js";

export const DEFAULT_RESULT_BUNDLE_FILE = "result-bundle.json";
export const DEFAULT_INLINE_RESULT_MAX_BYTES = 256 * 1024;

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export async function writeResultBundle(bundlePath, bundle) {
  assertResultBundle(bundle);
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
}

export function buildResultBundleFromSummary({ summary, jobSpec, inlineResultMaxBytes = DEFAULT_INLINE_RESULT_MAX_BYTES }) {
  if (!TERMINAL_STATUSES.has(summary.status)) {
    throw new CliError(`cannot bundle non-terminal job status: ${summary.status ?? ""}`, EXIT_CODES.invalidUsage);
  }
  const resultProjection = projectResultValue({
    value: summary.result ?? null,
    warnings: summary.result_warnings ?? [],
    inlineResultMaxBytes
  });
  const reason = summary.reason ?? null;
  return {
    schema_version: "git-runner.result-bundle.v1",
    job_id: summary.job_id,
    status: summary.status,
    reason,
    job: jobSpec,
    source: summary.source ?? jobSpec.source ?? {},
    worker: {
      worker_id: summary.worker_id ?? "unknown",
      routing_tag: jobSpec.worker?.routing_tag ?? jobSpec.worker?.tags?.[0] ?? "default"
    },
    timing: {
      submitted_at: summary.submitted_at ?? summary.started_at ?? summary.finished_at ?? new Date(0).toISOString(),
      started_at: summary.started_at ?? summary.finished_at ?? new Date(0).toISOString(),
      finished_at: summary.finished_at ?? summary.started_at ?? new Date(0).toISOString(),
      duration_ms: summary.duration_ms ?? 0
    },
    execution: {
      exit_code: summary.exit_code ?? 1,
      signal: summary.signal ?? null,
      timed_out: reason === "timeout",
      failed_stage: summary.failed_stage ?? null,
      commands: [
        ...(jobSpec.setup ?? []).map((setup) => typeof setup === "string" ? setup : setup.command),
        jobSpec.entry?.command
      ].filter(Boolean)
    },
    outputs: {
      stdout: {
        file: "stdout.log",
        bytes: summary.stdout_bytes ?? 0,
        truncated: Boolean(summary.stdout_truncated)
      },
      stderr: {
        file: "stderr.log",
        bytes: summary.stderr_bytes ?? 0,
        truncated: Boolean(summary.stderr_truncated)
      },
      result: {
        path: jobSpec.outputs?.result?.path ?? null,
        schema: jobSpec.outputs?.result?.schema ?? { type: "none" },
        file: null,
        value: resultProjection.value,
        warnings: resultProjection.warnings
      },
      artifacts: projectArtifacts(summary.artifacts ?? [])
    },
    error: reason ? {
      status: summary.status,
      reason,
      message: messageForReason(reason),
      retryable: reason === "timeout" || reason === "command_failed",
      emitted_by: "git-runner get --bundle",
      details: summary.result_warnings ?? []
    } : null
  };
}

export function projectResultValue({ value, warnings, inlineResultMaxBytes = DEFAULT_INLINE_RESULT_MAX_BYTES }) {
  if (value === null) {
    return { value: null, warnings };
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes <= inlineResultMaxBytes) {
    return { value, warnings };
  }
  return {
    value: null,
    warnings: [
      ...warnings,
      {
        code: "result_omitted_from_bundle",
        message: "result JSON exceeded inline bundle limit",
        bytes,
        max_bytes: inlineResultMaxBytes
      }
    ]
  };
}

function projectArtifacts(artifacts) {
  return artifacts.map((artifact) => ({
    name: artifact.name ?? null,
    path: artifact.path,
    kind: artifact.kind ?? null,
    media_type: artifact.media_type ?? null,
    required: Boolean(artifact.required),
    file: artifact.missing ? null : artifact.stored_path ?? artifact.file ?? null,
    bytes: artifact.size_bytes ?? artifact.bytes ?? 0,
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    missing: Boolean(artifact.missing),
    ...(artifact.reason ? { reason: artifact.reason } : {})
  }));
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
    case "command_failed":
      return "command exited unsuccessfully";
    case "cancelled":
      return "job was cancelled";
    default:
      return reason;
  }
}
