import path from "node:path";
import { CliError, EXIT_CODES } from "./errors.js";

export function assertRelativePath(inputPath, label) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new CliError(`${label} is required`, EXIT_CODES.invalidUsage);
  }
  if (path.isAbsolute(inputPath)) {
    throw new CliError(`${label} must be relative: ${inputPath}`, EXIT_CODES.invalidUsage);
  }
}

export function resolveInside(root, relativePath, label) {
  assertRelativePath(relativePath, label);
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, relativePath);
  const relative = path.relative(absoluteRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new CliError(`${label} escapes root: ${relativePath}`, EXIT_CODES.invalidUsage);
}
