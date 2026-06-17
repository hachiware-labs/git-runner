import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager
} from "@nats-io/jetstream";

export const JOB_STREAM = "GIT_RUNNER_JOBS";
export const JOB_SUBJECTS = ["git-runner.jobs.*"];
const ACK_WAIT_NANOS = 30_000_000_000;

export async function publishJetStreamJob({ connection, subject, payload, jobId }) {
  await ensureJobStream(connection);
  const js = jetstream(connection);
  return js.publish(subject, payload, {
    msgID: jobId,
    expect: { streamName: JOB_STREAM }
  });
}

export async function getJetStreamJobConsumer({ connection, tag }) {
  await ensureJobStream(connection);
  await ensureJobConsumer({ connection, tag });
  const js = jetstream(connection);
  return js.consumers.get(JOB_STREAM, durableNameForTag(tag));
}

async function ensureJobStream(connection) {
  const jsm = await jetstreamManager(connection);
  try {
    await jsm.streams.info(JOB_STREAM);
    return;
  } catch {
    await jsm.streams.add({
      name: JOB_STREAM,
      subjects: JOB_SUBJECTS,
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File
    });
  }
}

async function ensureJobConsumer({ connection, tag }) {
  const jsm = await jetstreamManager(connection);
  const durable = durableNameForTag(tag);
  try {
    await jsm.consumers.info(JOB_STREAM, durable);
    return;
  } catch {
    await jsm.consumers.add(JOB_STREAM, {
      durable_name: durable,
      filter_subject: `git-runner.jobs.${tag}`,
      ack_policy: AckPolicy.Explicit,
      ack_wait: ACK_WAIT_NANOS,
      deliver_policy: DeliverPolicy.All,
      max_ack_pending: 1
    });
  }
}

function durableNameForTag(tag) {
  return `git_runner_${tag.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
