/**
 * Injected time and randomness.
 *
 * Anything in the framework that reads the wall clock or generates random
 * values takes a `Clock` / `Random` from here. That is what makes seeders,
 * tokens, and retries deterministic under test.
 */

export interface Clock {
  now(): Date;
  /** ISO-8601 with millisecond precision. */
  iso(): string;
  /** Monotonic milliseconds since process/session start, for durations. */
  monotonicMs(): number;
}

export interface Random {
  /** Uniform float in [0, 1). */
  next(): number;
  /** RFC 4122 v4 identifier. */
  uuid(): string;
  /** Cryptographically secure bytes (never `Math.random`). */
  bytes(length: number): Uint8Array;
}

export function systemClock(): Clock {
  const startedAt = performance.now();
  return {
    now: () => new Date(),
    iso: () => new Date().toISOString(),
    monotonicMs: () => performance.now() - startedAt,
  };
}

export function systemRandom(): Random {
  return {
    next: () => {
      const buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      return (buffer[0] ?? 0) / 0x1_0000_0000;
    },
    uuid: () => crypto.randomUUID(),
    bytes: (length: number) => {
      const buffer = new Uint8Array(length);
      crypto.getRandomValues(buffer);
      return buffer;
    },
  };
}
