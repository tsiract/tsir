/** The `memory` API-key store: tests and `make dev`. Same honest limits as the memory sessions. */

import type { ApiKeyRecord, ApiKeyStore } from '../keys.ts';

export interface MemoryApiKeyStore extends ApiKeyStore {
  readonly size: number;
  readonly sharedAcrossInstances: false;
}

/**
 * A shallow spread would share the `scopes` array with the caller, so a handler that pushes to a
 * record it read back would silently edit the store. Copy the one nested value there is.
 */
function copy(record: ApiKeyRecord): ApiKeyRecord {
  return { ...record, scopes: record.scopes.slice() };
}

export function memoryApiKeyStore(): MemoryApiKeyStore {
  const rows = new Map<string, ApiKeyRecord>();
  return {
    sharedAcrossInstances: false,
    get size() {
      return rows.size;
    },
    async put(record) {
      rows.set(record.id, copy(record));
    },
    async get(id) {
      const record = rows.get(id);
      return record === undefined ? undefined : copy(record);
    },
    async list(subject) {
      return [...rows.values()]
        .filter((record) => record.subject === subject)
        .map((record) => copy(record));
    },
    async revoke(id, at) {
      const record = rows.get(id);
      if (record === undefined) return false;
      rows.set(id, { ...record, revokedAt: at });
      return true;
    },
    async touch(id, at) {
      const record = rows.get(id);
      if (record !== undefined) rows.set(id, { ...record, lastUsedAt: at });
    },
  };
}
