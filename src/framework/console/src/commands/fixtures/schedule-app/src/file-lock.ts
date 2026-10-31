// A lock that survives the process, so `schedule:run` and `schedule:work` can be tested the way
// they actually run: one CLI process each, sharing one state file.
//
// It is a `LockProvider` and nothing more — the scheduler does not know it is a file, which is
// the point of the port. `shared: true` because two processes really do see one lock here; the
// real drivers are `memoryLock` (`shared: false`) and `databaseLock` (`shared: true`).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LockHandle, LockProvider } from '@tsir/schedule';

interface Entry {
  readonly owner: string;
  readonly expiresAt: number;
}

export function fileLock(file = join(process.cwd(), '.locks.json')): LockProvider {
  const read = (): Record<string, Entry> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
    } catch {
      return {};
    }
  };
  const write = (state: Record<string, Entry>): void => {
    writeFileSync(file, JSON.stringify(state), 'utf8');
  };
  const live = (state: Record<string, Entry>, name: string, now: number): Entry | undefined => {
    const entry = state[name];
    if (entry === undefined || entry.expiresAt <= now) return undefined;
    return entry;
  };

  return {
    name: 'file',
    capabilities: { shared: true, expiry: true },

    async acquire({ name, owner, ttlMs, now }) {
      const state = read();
      if (live(state, name, now) !== undefined) return undefined;
      const entry = { owner, expiresAt: now + ttlMs };
      state[name] = entry;
      write(state);
      return { name, ...entry };
    },

    async release({ name, owner, now }) {
      const state = read();
      const entry = live(state, name, now);
      if (entry === undefined || entry.owner !== owner) return false;
      delete state[name];
      write(state);
      return true;
    },

    async inspect(name, now) {
      const entry = live(read(), name, now);
      return entry === undefined ? undefined : { name, ...entry };
    },

    async list(now) {
      const handles: LockHandle[] = [];
      for (const [name, entry] of Object.entries(read())) {
        if (entry.expiresAt > now) handles.push({ name, ...entry });
      }
      return handles;
    },
  };
}
