import { connect } from "@nats-io/transport-node";
import { CliError, EXIT_CODES } from "./errors.js";

const textEncoder = new TextEncoder();

export async function publishJob({ natsUrl, subject, jobSpec, requireWorker = true, workerReadySubject }) {
  let connection;
  try {
    connection = await connect({ servers: natsUrl });
    if (requireWorker) {
      await requireReadyWorker({ connection, natsUrl, workerReadySubject, jobSpec });
    }
    connection.publish(subject, textEncoder.encode(JSON.stringify(jobSpec)));
    await connection.drain();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`NATS publish failed for ${subject} at ${natsUrl}: ${error.message}`, EXIT_CODES.natsFailure);
  } finally {
    if (connection && !connection.isClosed()) {
      await connection.close();
    }
  }
}

async function requireReadyWorker({ connection, natsUrl, workerReadySubject, jobSpec }) {
  try {
    await connection.request(
      workerReadySubject,
      textEncoder.encode(JSON.stringify({
        schema_version: 1,
        job_id: jobSpec.job_id,
        source: jobSpec.source,
        worker: jobSpec.worker
      })),
      { timeout: 1000 }
    );
  } catch (error) {
    throw new CliError(
      `no ready worker responded on ${workerReadySubject} at ${natsUrl}; start a matching worker before submit or pass --no-require-worker`,
      EXIT_CODES.natsFailure
    );
  }
}
