import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { constructWebhookEvent } from './index.ts';

describe('cashier webhooks', () => {
  test('verifies a valid signature', async () => {
    const secret = 'whsec_test';
    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'customer.created',
      data: { object: {} },
      created: Date.now() / 1000,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    const event = await constructWebhookEvent(payload, `t=${timestamp},v1=${sig}`, secret);
    expect(event.type).toBe('customer.created');
  });

  test('rejects a tampered payload', async () => {
    const secret = 'whsec_test';
    const payload = JSON.stringify({ id: 'evt_1', type: 'customer.created' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      constructWebhookEvent('tampered', `t=${timestamp},v1=${sig}`, secret),
    ).rejects.toThrow();
  });

  test('rejects a stale timestamp', async () => {
    const secret = 'whsec_test';
    const payload = '{}';
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      constructWebhookEvent(payload, `t=${timestamp},v1=${sig}`, secret),
    ).rejects.toThrow();
  });
});
