import { describe, expect, test } from 'bun:test';
import { memoryBroadcaster } from './index.ts';

describe('broadcast memory', () => {
  test('subscribes and publishes', async () => {
    const b = memoryBroadcaster();
    let received: unknown = null;
    b.subscribe('orders', (msg) => {
      received = msg.data;
    });
    await b.publish('orders', 'created', { id: 1 });
    expect(received).toEqual({ id: 1 });
  });

  test('unsubscribe stops delivery', async () => {
    const b = memoryBroadcaster();
    let count = 0;
    const unsub = b.subscribe('orders', () => {
      count++;
    });
    await b.publish('orders', 'x', 1);
    unsub();
    await b.publish('orders', 'x', 1);
    expect(count).toBe(1);
  });

  test('separate channels are isolated', async () => {
    const b = memoryBroadcaster();
    let a = 0;
    let c = 0;
    b.subscribe('a', () => {
      a++;
    });
    b.subscribe('c', () => {
      c++;
    });
    await b.publish('a', 'x', 1);
    expect(a).toBe(1);
    expect(c).toBe(0);
  });
});
