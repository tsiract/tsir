/**
 * Internal invoke and publish (`DPL-030`).
 *
 * The transport is pluggable, so these tests inject an in-process mock instead of
 * reaching the AWS SDK. The real AWS flow is covered by `local-aws.test.ts`.
 */

import { describe, expect, test } from 'bun:test';

import {
  invokeUnit,
  publish,
  setInternalTransport,
} from './internal.ts';
import type { InternalTransport } from './internal.ts';

class FakeTransport implements InternalTransport {
  readonly published: { topic: string; message: unknown }[] = [];
  readonly invoked: { unit: string; task: string; input: Record<string, unknown> }[] = [];

  async publish(topic: string, message: unknown): Promise<void> {
    this.published.push({ topic, message });
  }

  async invoke(unit: string, task: string, input: Record<string, unknown>): Promise<unknown> {
    this.invoked.push({ unit, task, input });
    return { ok: true, task };
  }
}

describe('publish (DPL-030)', () => {
  test('routes the topic and message through the active transport', async () => {
    const fake = new FakeTransport();
    setInternalTransport(fake);
    await publish('orders', { orderId: 'ord-1' });

    expect(fake.published).toEqual([{ topic: 'orders', message: { orderId: 'ord-1' } }]);
    setInternalTransport(undefined);
  });
});

describe('invokeUnit (DPL-030)', () => {
  test('routes the unit, task and input through the active transport', async () => {
    const fake = new FakeTransport();
    setInternalTransport(fake);
    const result = await invokeUnit('admin', 'process-refund', { amount: 42 });

    expect(fake.invoked).toEqual([
      { unit: 'admin', task: 'process-refund', input: { amount: 42 } },
    ]);
    expect(result).toEqual({ ok: true, task: 'process-refund' });
    setInternalTransport(undefined);
  });
});
