import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { CliError, EXIT_CODES } from "./errors.js";

const schemaPath = fileURLToPath(new URL("./schemas/git-runner.result-bundle.v1.schema.json", import.meta.url));
export const resultBundleSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(resultBundleSchema);

export function validateResultBundle(bundle) {
  const valid = validate(bundle);
  return {
    valid,
    errors: valid ? [] : [...(validate.errors ?? [])]
  };
}

export function assertResultBundle(bundle) {
  const result = validateResultBundle(bundle);
  if (result.valid) {
    return;
  }
  throw new CliError(`invalid Result Bundle: ${formatAjvErrors(result.errors)}`, EXIT_CODES.genericFailure);
}

function formatAjvErrors(errors) {
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}
