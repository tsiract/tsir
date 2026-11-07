/**
 * In-process local AWS mock (SNS + SQS) for end-to-end deploy testing.
 *
 * Without Docker/LocalStack this is how the framework proves its AWS
 * adapters work: an in-memory SNS topic publishes to either a direct Lambda
 * handler (DPL-027) or to an SQS queue that a Lambda consumes (DPL-028). The
 * messages flow through the *real* `toLambdaHandler` router, so a regression
 * in event-shape detection or message parsing is a red test, not a production
 * incident.
 *
 * The mock speaks the Lambda invocation contract (an event object → the
 * handler), not the AWS HTTP API. That is enough: the platform's job is to
 * hand the event to the handler; the handler's job is everything from there.
 */

import { TsirError } from '@tsir/core';
import type { LambdaContextLike } from './lambda.ts';

export interface LocalAwsOptions {
  readonly context?: LambdaContextLike;
}

interface SnsTopic {
  readonly arn: string;
  /** Direct Lambda subscribers (DPL-027). */
  readonly directSubscribers: Set<(record: unknown) => Promise<void>>;
  /** SQS queues the topic fans out to (DPL-028). */
  readonly queueSubscribers: Set<SqsQueue>;
}

interface SqsQueue {
  readonly name: string;
  readonly arn: string;
  /** Messages waiting to be delivered. */
  readonly messages: { id: string; body: string }[];
  /** Lambda consumer of this queue. */
  consumer?: (
    records: unknown[],
  ) => Promise<{ batchItemFailures?: readonly { itemIdentifier: string }[] }>;
}

function uuid(): string {
  // A stable, readable id is fine for a local mock: collision risk is zero.
  return `msg-${Math.random().toString(36).slice(2, 10)}`;
}

export class LocalAws {
  private readonly topics = new Map<string, SnsTopic>();
  private readonly queues = new Map<string, SqsQueue>();
  private readonly context: LambdaContextLike;

  constructor(options: LocalAwsOptions = {}) {
    this.context = options.context ?? {
      functionName: 'local',
      awsRequestId: 'local',
      getRemainingTimeInMillis: () => 30_000,
    };
  }

  createTopic(name: string): string {
    const arn = `arn:aws:sns:local:000000000000:${name}`;
    if (!this.topics.has(arn)) {
      this.topics.set(arn, {
        arn,
        directSubscribers: new Set(),
        queueSubscribers: new Set(),
      });
    }
    return arn;
  }

  createQueue(name: string): string {
    const arn = `arn:aws:sqs:local:000000000000:${name}`;
    if (!this.queues.has(name)) {
      this.queues.set(name, { name, arn, messages: [] });
    }
    return arn;
  }

  /** A direct SNS → Lambda subscription (DPL-027). */
  subscribeDirect(topicArn: string, handler: (record: unknown) => Promise<void>): void {
    const topic = this.topics.get(topicArn);
    if (topic === undefined)
      throw new TsirError('LOCAL_AWS', `topic ${topicArn} does not exist`, { kind: 'internal' });
    topic.directSubscribers.add(handler);
  }

  /** An SNS → SQS fan-out subscription (DPL-028). */
  subscribeQueue(topicArn: string, queueName: string): void {
    const topic = this.topics.get(topicArn);
    const queue = this.queues.get(queueName);
    if (topic === undefined)
      throw new TsirError('LOCAL_AWS', `topic ${topicArn} does not exist`, { kind: 'internal' });
    if (queue === undefined)
      throw new TsirError('LOCAL_AWS', `queue ${queueName} does not exist`, { kind: 'internal' });
    topic.queueSubscribers.add(queue);
  }

  /** Register the Lambda that consumes a queue. */
  setQueueConsumer(
    queueName: string,
    consumer: (
      records: unknown[],
    ) => Promise<{ batchItemFailures?: readonly { itemIdentifier: string }[] }>,
  ): void {
    const queue = this.queues.get(queueName);
    if (queue === undefined)
      throw new TsirError('LOCAL_AWS', `queue ${queueName} does not exist`, { kind: 'internal' });
    queue.consumer = consumer;
  }

  /**
   * Publish to an SNS topic. Mirrors `sns:Publish`: the message goes to every
   * direct subscriber as an SNS record, and to every subscribed queue as an
   * SQS message. Raw delivery is on for queues (the body is the published
   * message, not the SNS envelope) — that is what `RawMessageDelivery: true`
   * in the SAM template means.
   */
  async publish(topicArn: string, message: string, subject?: string): Promise<void> {
    const topic = this.topics.get(topicArn);
    if (topic === undefined)
      throw new TsirError('LOCAL_AWS', `topic ${topicArn} does not exist`, { kind: 'internal' });

    const messageId = uuid();

    // Direct subscribers get the SNS envelope.
    const snsRecord = {
      EventSource: 'aws:sns',
      Sns: {
        TopicArn: topicArn,
        MessageId: messageId,
        Subject: subject,
        Message: message,
        Timestamp: new Date().toISOString(),
      },
    };
    for (const subscriber of topic.directSubscribers) {
      await subscriber(snsRecord);
    }

    // Queue subscribers get the raw message body (RawMessageDelivery: true).
    for (const queue of topic.queueSubscribers) {
      queue.messages.push({ id: messageId, body: message });
      await this.drainQueue(queue);
    }
  }

  private async drainQueue(queue: SqsQueue): Promise<void> {
    if (queue.consumer === undefined) return;
    // Keep draining until the queue is empty. A retryable failure puts the
    // message back at the front; the next iteration retries it. A hard limit
    // (non-retryable) returns no failure and the message is gone. Bound the
    // loop so a permanently-failing message does not loop forever.
    let iterations = 0;
    while (queue.messages.length > 0 && iterations < 100) {
      const batch = queue.messages.splice(0, 10);
      const records = batch.map((m) => ({
        messageId: m.id,
        body: m.body,
        eventSource: 'aws:sqs',
        eventSourceARN: queue.arn,
      }));
      const result = await queue.consumer(records);
      const failed = new Set(result?.batchItemFailures?.map((f) => f.itemIdentifier) ?? []);
      for (const message of batch) {
        if (failed.has(message.id)) queue.messages.unshift(message);
      }
      iterations += 1;
      if (failed.size === 0) break;
    }
  }

  get contextForInvoke(): LambdaContextLike {
    return this.context;
  }
}
