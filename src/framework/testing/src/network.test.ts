import { afterEach, describe, expect, test } from 'bun:test';
import { installNetworkGuard, NETWORK_BLOCKED } from './network.ts';

/** Awaits a promise that must reject, and returns the rejection's message. Fails if it resolves. */
async function caught(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the promise to reject');
}

// Bun runs every test file in one process, so whatever fetch this file leaves behind is seen by
// the next file. Capture the fetch that was there before, and put exactly that back.
const fetchAtStart = globalThis.fetch;
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  globalThis.fetch = fetchAtStart;
});

/** A fetch that records the call and answers, so the guard's allow path can be seen. */
function recordingFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('ok');
  }) as typeof fetch;
  return { calls };
}

describe('installNetworkGuard (TST-008)', () => {
  test('refuses a public host, names it, and never calls the underlying fetch', async () => {
    const { calls } = recordingFetch();
    restore = installNetworkGuard();

    expect(await caught(fetch('https://api.example.com/v1'))).toContain(NETWORK_BLOCKED);
    expect(await caught(fetch('https://api.example.com/v1'))).toContain('api.example.com');
    expect(calls).toEqual([]);
  });

  test('allows loopback without configuration', async () => {
    const { calls } = recordingFetch();
    restore = installNetworkGuard();

    expect(await (await fetch('http://127.0.0.1:8787/health')).text()).toBe('ok');
    expect(await (await fetch('http://localhost:3000/')).text()).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  test('allows exactly the hosts it was given, case-insensitively', async () => {
    recordingFetch();
    restore = installNetworkGuard({ allowHosts: ['Mock.Internal'] });

    expect(await (await fetch('http://mock.internal/x')).text()).toBe('ok');
    expect(await caught(fetch('http://other.internal/x'))).toContain(NETWORK_BLOCKED);
  });

  test('refuses an unparseable URL rather than guessing a host', async () => {
    recordingFetch();
    restore = installNetworkGuard();

    expect(await caught(fetch('not a url'))).toContain('unparseable');
  });

  test('restore puts the previous fetch back', () => {
    const before = globalThis.fetch;
    const undo = installNetworkGuard();

    expect(globalThis.fetch).not.toBe(before);
    undo();
    expect(globalThis.fetch).toBe(before);
  });
});
