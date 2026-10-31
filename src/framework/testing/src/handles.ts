/**
 * Handle-leak detection for test apps (TST-007).
 *
 * An app that starts a timer and never stops it keeps the process alive, and the leak shows up
 * later as a slow suite or a hang in an unrelated test. Bun does not expose the list of live
 * handles, so while a test app is alive this module wraps the timer functions and records every
 * referenced timer it hands out. Timers that fire or are cleared are forgotten. Whatever is still
 * recorded when the app is disposed was started during the app's life and is still running.
 *
 * Unreferenced timers (`unref()`) are ignored: they do not keep the process alive, so they cannot
 * leak in the way this check is for.
 */

export interface LeakedHandle {
  readonly kind: 'timeout' | 'interval';
  readonly delayMs: number;
}

type TimerHandle = { hasRef?: () => boolean };

interface Tracked extends LeakedHandle {
  readonly seq: number;
  readonly handle: TimerHandle;
}

const originals = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
};

const live = new Map<TimerHandle, Tracked>();
let sequence = 0;
let active = 0;

function install(): void {
  // Assigned through `globalThis` so the tracker sees every caller, including code that
  // captured the global at call time rather than at import time.
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const wrapper = (): void => {
      live.delete(handle);
      callback(...args);
    };
    const handle = originals.setTimeout(wrapper, delay) as unknown as TimerHandle;
    live.set(handle, { kind: 'timeout', delayMs: delay ?? 0, seq: ++sequence, handle });
    return handle;
  }) as unknown as typeof globalThis.setTimeout;

  globalThis.setInterval = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = originals.setInterval(() => callback(...args), delay) as unknown as TimerHandle;
    live.set(handle, { kind: 'interval', delayMs: delay ?? 0, seq: ++sequence, handle });
    return handle;
  }) as unknown as typeof globalThis.setInterval;

  globalThis.clearTimeout = ((handle?: TimerHandle) => {
    if (handle !== undefined) live.delete(handle);
    return originals.clearTimeout(handle as never);
  }) as typeof globalThis.clearTimeout;

  globalThis.clearInterval = ((handle?: TimerHandle) => {
    if (handle !== undefined) live.delete(handle);
    return originals.clearInterval(handle as never);
  }) as typeof globalThis.clearInterval;
}

function uninstall(): void {
  globalThis.setTimeout = originals.setTimeout;
  globalThis.setInterval = originals.setInterval;
  globalThis.clearTimeout = originals.clearTimeout;
  globalThis.clearInterval = originals.clearInterval;
  live.clear();
}

/**
 * Starts tracking. The returned function stops tracking for this caller and reports the
 * referenced timers it started that are still running. Nested and overlapping callers are
 * supported: the wrappers come off when the last caller stops.
 */
export function beginHandleTracking(): () => readonly LeakedHandle[] {
  const mark = sequence;
  if (active === 0) install();
  active += 1;
  let ended = false;

  return (): readonly LeakedHandle[] => {
    if (ended) return [];
    ended = true;
    const leaked = [...live.values()]
      .filter((entry) => entry.seq > mark && entry.handle.hasRef?.() !== false)
      .map(({ kind, delayMs }) => ({ kind, delayMs }));
    active -= 1;
    if (active === 0) uninstall();
    return leaked;
  };
}
