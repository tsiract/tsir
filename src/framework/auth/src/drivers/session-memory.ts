/**
 * The `memory` session store — for tests, and for `make dev`.
 *
 * It is honest about what it cannot do: everything is per process, so two Workers isolates do not
 * share a session. That is why `@tsir/notify`'s `memory` channel and this one both declare
 * `delivers: false` / `shared: false` in spirit — the difference is that a session store is not a
 * capability with a flag, so the class of failure is written here and in.
 */

import type { SessionRecord, SessionStore } from '../session.ts';

export interface MemorySessionStore extends SessionStore {
  readonly size: number;
  readonly sharedAcrossInstances: false;
}

export function memorySessionStore(): MemorySessionStore {
  const rows = new Map<string, SessionRecord>();

  return {
    sharedAcrossInstances: false,
    get size() {
      return rows.size;
    },
    async put(record) {
      rows.set(record.id, { ...record });
    },
    async get(id) {
      const record = rows.get(id);
      return record === undefined ? undefined : { ...record };
    },
    async delete(id) {
      rows.delete(id);
    },
    async deleteSubject(subject) {
      let removed = 0;
      for (const [id, record] of rows) {
        if (record.subject !== subject) continue;
        rows.delete(id);
        removed += 1;
      }
      return removed;
    },
    async touch(id, lastSeenAt) {
      const record = rows.get(id);
      if (record !== undefined) rows.set(id, { ...record, lastSeenAt });
    },
  };
}
