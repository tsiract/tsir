/**
 * Internal invoke and publish (`DPL-030`).
 *
 * A service method sometimes needs to reach another unit: hand off a message for fan-out.
 * `publish` sends a message to an SNS topic (delivered to any `@OnSns({ topic })` listener),
 * and `invokeUnit` calls another unit's `@OnStepTask({ name })` synchronously.
 *
 * Both are checked against the declarations in two ways:
 *
 *   1. **Deploy-time.** The deploy graph already knows every `@OnSns` topic and every
 *      `@OnStepTask` name; `publish`/`invokeUnit` references are checked against those lists so a
 *      typo in a topic name fails the build, not a message that silently never arrives.
 *   2. **Run-time.** The transport validates that the target exists before calling the platform, so a
 *      misconfiguration fails fast with a named error rather than an AWS "not found".
 *
 * The transport is the only place that talks to AWS. It is pluggable so tests can inject an
 * in-process mock instead of reaching the SDK. In production the default transport uses
 * `@aws-sdk/client-sns` and `@aws-sdk/client-lambda`, imported lazily so the bundle does not
 * carry the SDK when the unit never calls these functions.
 */

import { invokeUnknown, publishUnknown } from './errors.ts';

/* ── transport ─────────────────────────────────────────────────────────────── */

/**
 * The mechanism `publish` and `invokeUnit` route through. The default is the AWS SDK;
 * tests inject an in-process mock so an end-to-end flow can run without LocalStack.
 */
export interface InternalTransport {
  publish(topic: string, message: unknown): Promise<void>;
  invoke(unit: string, task: string, input: Record<string, unknown>): Promise<unknown>;
}

let transport: InternalTransport | undefined;

/** Replace the transport. Pass `undefined` to restore the AWS default. */
export function setInternalTransport(next: InternalTransport | undefined): void {
  transport = next;
}

/* ── default (AWS) transport ──────────────────────────────────────────────────── */

/** The default transport, built lazily so the SDK is only loaded when actually used. */
function defaultTransport(): InternalTransport {
  return {
    async publish(topic, message) {
      const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
      const client = new SNSClient({});
      const topicArn = await resolveTopicArn(client, topic);
      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: typeof message === 'string' ? message : JSON.stringify(message),
        }),
      );
    },
    async invoke(unit, task, input) {
      const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
      const client = new LambdaClient({});
      // The deployed function name is `${AWS::StackName}-${unit}`. The stack name is injected
      // as `TSIR_STACK_NAME` by the SAM template (sam.ts). Falls back to the bare unit name
      // for local/test runs where the env var is not set.
      const stackName = process.env.TSIR_STACK_NAME;
      const functionName = stackName !== undefined ? `${stackName}-${unit}` : unit;
      const response = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify({ task, ...input })),
        }),
      );
      const payload = response.Payload?.transformToString();
      return payload === undefined || payload.length === 0
        ? undefined
        : (JSON.parse(payload) as unknown);
    },
  };
}

/** Resolve a topic name to its ARN. The Lambda's own account/region come from the runtime env. */
async function resolveTopicArn(
  client: { send: (command: unknown) => Promise<unknown> },
  topic: string,
): Promise<string> {
  // If the caller passed an ARN already, use it directly.
  if (topic.startsWith('arn:')) return topic;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const account = process.env.AWS_ACCOUNT_ID;
  if (region !== undefined && account !== undefined) {
    return `arn:aws:sns:${region}:${account}:${topic}`;
  }
  // Fall back to ListTopics so this works without explicit env in local runs.
  const { ListTopicsCommand } = await import('@aws-sdk/client-sns');
  const result = (await client.send(new ListTopicsCommand())) as {
    Topics?: { TopicArn?: string }[];
  };
  const match = result.Topics?.find((t) => t.TopicArn?.endsWith(`:${topic}`));
  if (match?.TopicArn === undefined) {
    throw publishUnknown({ topic });
  }
  return match.TopicArn;
}

/* ── public API ─────────────────────────────────────────────────────────────── */

/**
 * Publish a message to an SNS topic.
 *
 * The topic must match a `@OnSns({ topic })` listener somewhere in the app; the deploy
 * graph and the transport both check this.
 */
export function publish(topic: string, message: unknown): Promise<void> {
  const active = transport ?? defaultTransport();
  return active.publish(topic, message);
}

/**
 * Invoke another unit's `@OnStepTask({ name })` synchronously and return its result.
 *
 * `input` is the task payload: the platform wraps it as `{ task, ...input }` so the
 * target unit's `invoke` handler routes it by name.
 */
export function invokeUnit(
  unit: string,
  task: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const active = transport ?? defaultTransport();
  return active.invoke(unit, task, input);
}

/* Re-export the error helpers so callers can match on them in tests. */
export { invokeUnknown, publishUnknown };
