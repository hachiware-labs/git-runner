import { connect } from "@nats-io/transport-node";
import { CliError, EXIT_CODES } from "./errors.js";

export async function publishJob({ natsUrl, subject, jobSpec }) {
  let connection;
  try {
    connection = await connect({ servers: natsUrl });
    connection.publish(subject, new TextEncoder().encode(JSON.stringify(jobSpec)));
    await connection.drain();
  } catch (error) {
    throw new CliError(`NATS publish failed for ${subject} at ${natsUrl}: ${error.message}`, EXIT_CODES.natsFailure);
  } finally {
    if (connection && !connection.isClosed()) {
      await connection.close();
    }
  }
}
