import { connect } from "@nats-io/transport-node";
import { CliError, EXIT_CODES } from "./errors.js";

const textEncoder = new TextEncoder();

export async function publishJob({ natsUrl, subject, jobSpec, requireWorker = true }) {
  let connection;
  try {
    connection = await connect({ servers: natsUrl });
    const payload = textEncoder.encode(JSON.stringify(jobSpec));
    if (requireWorker) {
      await dispatchToReadyWorker({ connection, natsUrl, subject, payload });
    } else {
      connection.publish(subject, payload);
    }
    await connection.drain();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`NATS dispatch failed for ${subject} at ${natsUrl}: ${error.message}`, EXIT_CODES.natsFailure);
  } finally {
    if (connection && !connection.isClosed()) {
      await connection.close();
    }
  }
}

async function dispatchToReadyWorker({ connection, natsUrl, subject, payload }) {
  try {
    await connection.request(subject, payload, { timeout: 1000 });
  } catch (error) {
    throw new CliError(
      `no worker accepted ${subject} at ${natsUrl}; start a matching worker before submit or pass --no-require-worker`,
      EXIT_CODES.natsFailure
    );
  }
}
