export const EXIT_CODES = {
  success: 0,
  genericFailure: 1,
  invalidUsage: 2,
  gitFailure: 3,
  natsFailure: 4,
  jobStoreFailure: 5
};

export class CliError extends Error {
  constructor(message, exitCode = EXIT_CODES.genericFailure) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function formatError(error) {
  if (error instanceof CliError) {
    return `error: ${error.message}`;
  }
  return `error: ${error?.message ?? String(error)}`;
}
