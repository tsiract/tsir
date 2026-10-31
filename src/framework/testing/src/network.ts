/**
 * The network block for unit tests (TST-008).
 *
 * A unit test that reaches a real host is either flaky or leaking data, and the failure is
 * usually far from its cause. `installNetworkGuard` replaces `fetch` so that any request to a
 * host outside the allowlist throws at the call site, naming the URL. Loopback is allowed by
 * default, because the in-process tests and the dev server both use it.
 *
 * The guard is installed once per test process by the preload in `src/tools/test-preload.ts`.
 * It does not touch sockets: a request is refused before it leaves `fetch`.
 */

export const NETWORK_BLOCKED = 'TEST_NETWORK_BLOCKED';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface NetworkGuardOptions {
  /** Extra hosts a test may reach, for example a local mock server's host name. */
  readonly allowHosts?: readonly string[];
}

/** The host a request URL targets, lower-cased. Unparseable input has no host, and is refused. */
function hostOf(input: string | URL | Request): string | undefined {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Replaces `globalThis.fetch` with a guard that allows loopback and the listed hosts, and throws
 * for everything else. Returns a function that restores the previous `fetch`.
 */
export function installNetworkGuard(options: NetworkGuardOptions = {}): () => void {
  const allowed = new Set([...LOOPBACK, ...(options.allowHosts ?? []).map((h) => h.toLowerCase())]);
  const original = globalThis.fetch;

  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = hostOf(input);
    if (host === undefined || !allowed.has(host)) {
      const target = host ?? '(unparseable URL)';
      return Promise.reject(
        new Error(
          `${NETWORK_BLOCKED}: a unit test tried to reach "${target}". Stub the call, or pass ` +
            'its host to installNetworkGuard({ allowHosts }) if the test needs it.',
        ),
      );
    }
    return original(input, init);
  };

  globalThis.fetch = guarded as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
