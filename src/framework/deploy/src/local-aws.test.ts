/**
 * End-to-end AWS messaging proof (DPL-027, DPL-028).
 *
 * This is the test that says "the framework handles SNS and SQS for real":
 * it publishes to an in-memory SNS topic and asserts the message reaches a
 * Lambda handler through the *real* `toLambdaHandler` router — both as a
 * direct SNS subscription and as an SNS → SQS → Lambda fan-out.
 *
 * Without Docker/LocalStack this is the strongest available proof that the
 * Lambda adapter's event-shape detection and message parsing are correct.
 */

import { describe, expect, test } from 'bun:test';

import { toLambdaHandler } from './lambda.ts';
import { LocalAws } from './local-aws.test-support.ts';

describe('end-to-end · SNS → Lambda (DPL-027)', () => {
  test('a published message reaches the sns handler with the parsed body', async () => {
    const aws = new LocalAws();
    const topicArn = aws.createTopic('orders');

    let received: { id: string; topicArn: string; subject?: string; body: unknown } | undefined;
    const handler = toLambdaHandler({
      unit: 'notify',
      sns: async (message) => {
        received = {
          id: message.id,
          topicArn: message.topicArn,
          ...(message.subject !== undefined ? { subject: message.subject } : {}),
          body: message.body,
        };
      },
    });

    aws.subscribeDirect(topicArn, async (record) => {
      await handler({ Records: [record] }, aws.contextForInvoke);
    });

    await aws.publish(topicArn, JSON.stringify({ orderId: 'o_1' }), 'New order');

    expect(received).toBeDefined();
    expect(received!.topicArn).toBe(topicArn);
    expect(received!.subject).toBe('New order');
    expect(received!.body).toEqual({ orderId: 'o_1' });
  });
});

describe('end-to-end · SNS → SQS → Lambda (DPL-028)', () => {
  test('a published message reaches the queue handler via the SQS event shape', async () => {
    const aws = new LocalAws();
    const topicArn = aws.createTopic('orders');
    aws.createQueue('orders');
    aws.subscribeQueue(topicArn, 'orders');

    let receivedBody: unknown;
    let receivedSource: string | undefined;
    const handler = toLambdaHandler({
      unit: 'jobs',
      queue: async (message) => {
        receivedBody = message.body;
        receivedSource = message.record.eventSource;
      },
    });

    aws.setQueueConsumer('orders', async (records) => {
      const result = await handler({ Records: records }, aws.contextForInvoke);
      return result.batchItemFailures ? { batchItemFailures: result.batchItemFailures } : {};
    });

    await aws.publish(topicArn, JSON.stringify({ orderId: 'o_2' }));

    // RawMessageDelivery means the queue body is the published JSON, not the SNS envelope.
    expect(receivedBody).toEqual({ orderId: 'o_2' });
    expect(receivedSource).toBe('aws:sqs');
  });

  test('a poison message is reported as a batch failure and redelivered', async () => {
    const aws = new LocalAws();
    const topicArn = aws.createTopic('orders');
    aws.createQueue('orders');
    aws.subscribeQueue(topicArn, 'orders');

    let attempts = 0;
    const handler = toLambdaHandler({
      unit: 'jobs',
      queue: async () => {
        attempts += 1;
        // First attempt fails with a retryable error; the second succeeds.
        if (attempts === 1) {
          const error = new Error('transient');
          (error as unknown as { retryable: boolean }).retryable = true;
          throw error;
        }
      },
    });

    aws.setQueueConsumer('orders', async (records) => {
      const result = await handler({ Records: records }, aws.contextForInvoke);
      return result.batchItemFailures ? { batchItemFailures: result.batchItemFailures } : {};
    });

    await aws.publish(topicArn, 'payload');
    // The retryable failure puts the message back; the mock drains again immediately.
    expect(attempts).toBe(2);
  });
});
