/**
 * The `sqs` driver (`§ 4.2`, `QUEUE-16`) — opt-in, for Lambda and for a Bun poller.
 *
 * The client is **app-supplied** (ADR-0027 § 1): `@aws-sdk/client-sqs` is not a dependency of
 * this package, and does not want to be. The shape below is the four calls this driver makes,
 * which the SDK satisfies structurally once you unwrap its `{ Body, MessageId, … }` response —
 * `sqsClientOf()` does that unwrapping so the driver's own tests need no AWS account and the
 * application's code needs no adapter.
 *
 * Four answers worth stating:
 *
 *   · **`transactional: false`.** `SendMessage` is an HTTP call; it cannot enlist in the write
 *     that caused it. The outbox is mandatory (`requireOutbox`), exactly as on Queues.
 *   · **`delay` depends on the queue kind.** A standard queue takes `DelaySeconds` up to 900;
 *     a **FIFO** queue does not accept `DelaySeconds` at all, so `fifo: true` reports
 *     `delay: false` and a delayed dispatch is refused rather than delivered immediately.
 *   · **`ordered` is the FIFO flag.** A standard queue reorders under load; claiming otherwise
 *     would let a consumer's ordering assumption survive until it does not.
 *   · **`deadLetter` only with a store** — same reasoning as the Queues driver: SQS's redrive
 *     policy moves messages the *broker* gave up on, and it cannot replay one by id. With an
 *     SQL client the driver keeps `queue_dead`, so `queue:failed`/`queue:retry` work the same
 *     way on every driver.
 *
 * Visibility is the lease, and it is renewed on read: `receiveMessage` sets the visibility
 * timeout to the worker's lease, so a crashed consumer's message reappears for the next one.
 */

import { unsupportedOperation } from '../errors.ts';
import { createDeadLetterStore, type DeadLetterStore } from '../dead.ts';
import type { JobMessage, QueueBackend, QueueCapabilities, QueueDriver } from '../port.ts';
import type { QueueSql } from '../sql.ts';

/** SQS's own ceiling for `DelaySeconds` on a standard queue: 15 minutes. */
export const SQS_MAX_DELAY_SECONDS = 15 * 60;
/** SQS's own ceiling for `ReceiveMessage`. */
export const SQS_MAX_BATCH = 10;

export const SQS_CAPABILITIES = {
  transactional: false,
  delay: true,
  cancel: false,
  persistent: true,
  ordered: false,
  deadLetter: true,
  // A standard queue does not dedupe; a FIFO queue does, on `MessageDeduplicationId` — which is
  // exactly where the driver puts an idempotency key. The flag is the queue's, like `delay`.
  idempotency: false,
} as const satisfies QueueCapabilities;

/** One message as `ReceiveMessage` returns it. */
export interface SqsMessageLike {
  readonly MessageId?: string | undefined;
  /** The driver's own JSON, so this is a string, not an object. */
  readonly Body?: string | undefined;
  readonly ReceiptHandle?: string | undefined;
  /** `ApproximateReceiveCount` is the delivery count, which is what the port calls attempts. */
  readonly Attributes?: Readonly<Record<string, string>> | undefined;
}

export interface SqsSendInput {
  readonly QueueUrl: string;
  readonly MessageBody: string;
  readonly DelaySeconds?: number | undefined;
  /** FIFO only: the dedupe key, which is how SQS spells an idempotency key. */
  readonly MessageDeduplicationId?: string | undefined;
  readonly MessageGroupId?: string | undefined;
}

export interface SqsReceiveInput {
  readonly QueueUrl: string;
  readonly MaxNumberOfMessages?: number | undefined;
  readonly WaitTimeSeconds?: number | undefined;
  readonly VisibilityTimeout?: number | undefined;
  readonly AttributeNames?: readonly string[] | undefined;
  readonly MessageAttributeNames?: readonly string[] | undefined;
}

/** The four calls this driver makes. `@aws-sdk/client-sqs`'s `SQSClient` satisfies it. */
export interface SqsLike {
  sendMessage(input: SqsSendInput): Promise<unknown>;
  receiveMessage(
    input: SqsReceiveInput,
  ): Promise<{ readonly Messages?: readonly SqsMessageLike[] }>;
  deleteMessage(input: {
    readonly QueueUrl: string;
    readonly ReceiptHandle: string;
  }): Promise<unknown>;
  changeMessageVisibility(input: {
    readonly QueueUrl: string;
    readonly ReceiptHandle: string;
    readonly VisibilityTimeout: number;
  }): Promise<unknown>;
}

export interface SqsOptions {
  readonly client: SqsLike;
  /** The queue URL — the address, not a hint: one client may serve several connections. */
  readonly queueUrl: string;
  /** FIFO queues keep order and refuse `DelaySeconds`; standard queues do neither. */
  readonly fifo?: boolean | undefined;
  /** FIFO only, and required by SQS for every send. Default `'default'`. */
  readonly messageGroupId?: string | undefined;
  /** Default `queue_dead`. Omit `sql` and `deadLetter` becomes `false`. */
  readonly sql?: QueueSql | undefined;
  readonly deadTable?: string | undefined;
  /** Long-poll wait. Default 0 so `--once` returns immediately; a drain loop passes 20. */
  readonly waitTimeSeconds?: number | undefined;
  readonly now?: (() => number) | undefined;
}

function parseBody(body: string | undefined, fallback: string): JobMessage | undefined {
  if (body === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return undefined;
    if (typeof candidate.payload !== 'string') return undefined;
    return {
      id: candidate.id,
      name: candidate.name,
      payload: candidate.payload,
      connection: typeof candidate.connection === 'string' ? candidate.connection : fallback,
      attempts: 0,
      maxAttempts: typeof candidate.maxAttempts === 'number' ? candidate.maxAttempts : 5,
      availableAt: typeof candidate.availableAt === 'number' ? candidate.availableAt : 0,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
      ...(typeof candidate.idempotencyKey === 'string'
        ? { idempotencyKey: candidate.idempotencyKey }
        : {}),
      ...(typeof candidate.lastError === 'string' ? { lastError: candidate.lastError } : {}),
    };
  } catch {
    return undefined;
  }
}

export function sqsDriver(options: SqsOptions): QueueDriver<never> {
  const now = options.now ?? ((): number => Date.now());
  const fifo = options.fifo === true;

  const capabilities: QueueCapabilities = {
    ...SQS_CAPABILITIES,
    // FIFO queues reject `DelaySeconds`; a standard queue accepts up to 15 minutes. The
    // capability is the queue's, not the driver's, which is why it is computed here.
    delay: !fifo,
    ordered: fifo,
    // FIFO's dedupe window is five minutes, and `MessageDeduplicationId` is the key.
    idempotency: fifo,
    ...(options.sql === undefined ? { deadLetter: false } : {}),
  };

  return {
    name: 'sqs',
    capabilities,

    open(): QueueBackend {
      const deadStore: DeadLetterStore | undefined =
        options.sql === undefined
          ? undefined
          : createDeadLetterStore({
              sql: options.sql,
              ...(options.deadTable === undefined ? {} : { table: options.deadTable }),
            });

      /** Receipt handles for the messages this process has reserved, by message id. */
      const handles = new Map<string, string>();

      const backend: QueueBackend = {
        name: 'sqs',
        capabilities,
        now,

        async push(message) {
          const input: SqsSendInput = {
            QueueUrl: options.queueUrl,
            MessageBody: JSON.stringify(message),
            ...(message.idempotencyKey === undefined
              ? {}
              : fifo
                ? { MessageDeduplicationId: message.idempotencyKey }
                : {}),
            ...(fifo ? { MessageGroupId: options.messageGroupId ?? 'default' } : {}),
          };

          const delaySeconds = Math.max(0, Math.ceil((message.availableAt - now()) / 1_000));
          if (delaySeconds > 0) {
            if (fifo) {
              throw unsupportedOperation(
                message.connection,
                'sqs',
                'a delayed dispatch on a FIFO queue',
                'SQS rejects DelaySeconds on FIFO queues; use a standard queue for this connection',
              );
            }
            if (delaySeconds > SQS_MAX_DELAY_SECONDS) {
              // Refused, not clamped — same reasoning as the Queues driver: a job that runs
              // 14 minutes early is a bug someone will spend a day not finding.
              throw unsupportedOperation(
                message.connection,
                'sqs',
                `a delay of ${String(delaySeconds)} s`,
                `SQS's maximum is ${String(SQS_MAX_DELAY_SECONDS)} s; dispatch later and re-queue instead`,
              );
            }
          }

          await options.client.sendMessage(
            delaySeconds === 0 ? input : { ...input, DelaySeconds: delaySeconds },
          );
        },

        async reserve({ connection, limit, leaseMs }) {
          const response = await options.client.receiveMessage({
            QueueUrl: options.queueUrl,
            MaxNumberOfMessages: Math.min(limit, SQS_MAX_BATCH),
            WaitTimeSeconds: options.waitTimeSeconds ?? 0,
            VisibilityTimeout: Math.ceil(leaseMs / 1_000),
            AttributeNames: ['ApproximateReceiveCount'],
          });

          const claimed: JobMessage[] = [];
          for (const received of response.Messages ?? []) {
            const parsed = parseBody(received.Body, connection);
            // A body this driver did not write: delete it rather than let it redeliver
            // forever. One malformed message must not become a queue-wide outage.
            if (parsed === undefined || received.ReceiptHandle === undefined) {
              if (received.ReceiptHandle !== undefined) {
                await options.client.deleteMessage({
                  QueueUrl: options.queueUrl,
                  ReceiptHandle: received.ReceiptHandle,
                });
              }
              continue;
            }

            handles.set(parsed.id, received.ReceiptHandle);
            // coercion-ok: `ApproximateReceiveCount` is a decimal string SQS writes; a missing
            // or corrupt count means "first delivery", not a crash in the receive loop.
            const count = Number(received.Attributes?.['ApproximateReceiveCount'] ?? 1);
            claimed.push({
              ...parsed,
              // A body with no connection is the connection it arrived on: the queue URL is the
              // address, so a message cannot be "unaddressed" once it is in front of us.
              connection: parsed.connection === '' ? connection : parsed.connection,
              attempts: Number.isFinite(count) && count >= 1 ? count : 1,
            });
          }
          return claimed;
        },

        async complete(message) {
          const receipt = handles.get(message.id);
          handles.delete(message.id);
          if (receipt === undefined) return;
          await options.client.deleteMessage({
            QueueUrl: options.queueUrl,
            ReceiptHandle: receipt,
          });
        },

        async fail(message, { error, retryAt }) {
          const receipt = handles.get(message.id);
          handles.delete(message.id);

          if (retryAt === undefined) {
            // Exhausted: record it, then delete. `ChangeMessageVisibility(0)` would put it
            // straight back into the same consumer's next poll — a spin, not a retry.
            await deadStore?.record({ ...message, lastError: error });
            if (receipt !== undefined) {
              await options.client.deleteMessage({
                QueueUrl: options.queueUrl,
                ReceiptHandle: receipt,
              });
            }
            return;
          }

          if (receipt === undefined) return;
          // The platform schedules the retry: hide the message until it is due, so no consumer
          // sees it in the meantime. This is SQS's own delay mechanism, used for retries.
          const delaySeconds = Math.max(0, Math.ceil((retryAt - now()) / 1_000));
          await options.client.changeMessageVisibility({
            QueueUrl: options.queueUrl,
            ReceiptHandle: receipt,
            VisibilityTimeout: delaySeconds,
          });
        },

        async dead(limit) {
          return deadStore === undefined ? [] : deadStore.list(limit);
        },

        async replay(id, clock) {
          if (deadStore === undefined) return false;
          const [message] = (await deadStore.list(1_000)).filter((entry) => entry.id === id);
          if (message === undefined) return false;

          await backend.push({ ...message, attempts: 0, availableAt: clock });
          await deadStore.remove(id);
          return true;
        },

        async discard(id) {
          if (deadStore === undefined) return false;
          return deadStore.remove(id);
        },

        async size() {
          // The queue's depth is the broker's number, and reading it costs an API call this
          // driver does not make on a health endpoint's behalf.
          return 0;
        },

        async purge() {
          handles.clear();
          await deadStore?.clear();
        },
      };

      return backend;
    },
  };
}

export const sqsCapabilities = SQS_CAPABILITIES;

/**
 * Adapt an `@aws-sdk/client-sqs`-shaped client to `SqsLike`.
 *
 * The SDK is duck-typed on purpose (ADR-0027 § 1), and this is the one place the unwrapping
 * lives: `send(Command)` returns `{ Messages, $metadata }`, and every call site would
 * otherwise repeat that. Written against the *command objects*, so this package never imports
 * the SDK and never learns its types.
 */
export interface AwsSqsClientLike {
  send(command: unknown): Promise<unknown>;
}

export function sqsClientOf(
  client: AwsSqsClientLike,
  commands: {
    readonly SendMessageCommand: new (input: SqsSendInput) => unknown;
    readonly ReceiveMessageCommand: new (input: SqsReceiveInput) => unknown;
    readonly DeleteMessageCommand: new (input: Record<string, unknown>) => unknown;
    readonly ChangeMessageVisibilityCommand: new (input: Record<string, unknown>) => unknown;
  },
): SqsLike {
  return {
    sendMessage: async (input) => client.send(new commands.SendMessageCommand(input)),
    receiveMessage: async (input) => {
      const response = (await client.send(new commands.ReceiveMessageCommand(input))) as {
        readonly Messages?: readonly SqsMessageLike[];
      };
      return { Messages: response.Messages ?? [] };
    },
    deleteMessage: async (input) => client.send(new commands.DeleteMessageCommand(input)),
    changeMessageVisibility: async (input) =>
      client.send(new commands.ChangeMessageVisibilityCommand(input)),
  };
}
