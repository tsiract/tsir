/**
 * Queue-backed indexing (`SRCH-7`).
 *
 * The claim under test is narrow and the whole point: `index`/`remove` reach the queue instead of
 * the engine, `search` never does, and a dispatch that is not accepted is an error rather than a
 * silent no-op. Each case asserts against a recording engine *and* a recording queue, so a
 * pass cannot come from the engine having been called by accident.
 */

import { describe, expect, test } from 'bun:test';
import { TsirError } from '@tsir/container';
import {
  SEARCH_INDEX_JOB,
  SEARCH_REMOVE_JOB,
  searchableIndexer,
  type SearchJobDispatcher,
} from './indexer.ts';
import { memoryEngine, type SearchDocument } from './scout.ts';

interface Dispatch {
  readonly name: string;
  readonly payload: unknown;
  readonly idempotencyKey: string | undefined;
}

/** A queue that records and accepts everything. */
function recordingQueue(accepted = true): SearchJobDispatcher & { readonly calls: Dispatch[] } {
  const calls: Dispatch[] = [];
  return {
    calls,
    async dispatch(job, payload, options) {
      calls.push({ name: job.name, payload, idempotencyKey: options?.idempotencyKey });
      return { accepted };
    },
  };
}

/** An engine that records write calls, wrapping a real one so `search` still answers. */
function recordingEngine(): { engine: ReturnType<typeof memoryEngine>; writes: string[] } {
  const inner = memoryEngine();
  const writes: string[] = [];
  return {
    writes,
    engine: {
      index(doc: SearchDocument) {
        writes.push(`index:${doc.id}`);
        return inner.index(doc);
      },
      remove(id: string) {
        writes.push(`remove:${id}`);
        return inner.remove(id);
      },
      search: (query, limit) => inner.search(query, limit),
    },
  };
}

describe('the queue seam (SRCH-7)', () => {
  test('a write is queued, not indexed', async () => {
    const { engine, writes } = recordingEngine();
    const queue = recordingQueue();
    const indexed = searchableIndexer({ engine, queue });

    await indexed.index({ id: 'doc-1', fields: { title: 'Hello' } });

    expect(writes).toEqual([]); // the engine has done nothing yet
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]?.name).toBe(SEARCH_INDEX_JOB);
    expect(queue.calls[0]?.idempotencyKey).toBe('search:index:doc-1');
  });

  test('the payload is plain JSON, so it survives every driver', async () => {
    // A queued message is serialised by whichever backend holds it. A class instance, a `Map` or a
    // Date would arrive as something else on the other side, which is the bug a memory queue hides.
    const { engine } = recordingEngine();
    const queue = recordingQueue();
    const indexed = searchableIndexer({ engine, queue });

    await indexed.index({ id: 'doc-1', fields: { title: 'Hello', body: 'World' } });
    const payload = queue.calls[0]?.payload;
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test('index and remove for the same id get different keys, so neither is dropped', async () => {
    // Sharing a key would make the second dispatch a duplicate of the first: a delete that never
    // runs, on a document that stays findable.
    const { engine } = recordingEngine();
    const queue = recordingQueue();
    const indexed = searchableIndexer({ engine, queue });

    await indexed.index({ id: 'doc-1', fields: { title: 'Hello' } });
    await indexed.remove('doc-1');

    expect(queue.calls.map((c) => c.name)).toEqual([SEARCH_INDEX_JOB, SEARCH_REMOVE_JOB]);
    expect(queue.calls[0]?.idempotencyKey).not.toBe(queue.calls[1]?.idempotencyKey);
  });

  test('search is never queued', async () => {
    // The one operation on the request path. Deferring it would return a promise to search later.
    const { engine } = recordingEngine();
    const queue = recordingQueue();
    const indexed = searchableIndexer({ engine, queue });
    const doc = { id: 'doc-1', fields: { title: 'Hello' } };
    await engine.index(doc);

    expect(await indexed.search('hello')).toEqual([{ id: 'doc-1', score: 1 }]);
    expect(queue.calls).toEqual([]);
  });

  test('`inline` calls the engine directly, for a process with no worker', async () => {
    const { engine, writes } = recordingEngine();
    const queue = recordingQueue();
    const indexed = searchableIndexer({ engine, queue, inline: true });

    await indexed.index({ id: 'doc-1', fields: { title: 'Hello' } });

    expect(writes).toEqual(['index:doc-1']);
    expect(queue.calls).toEqual([]);
  });

  test('a rejected dispatch throws rather than pretending the write landed', async () => {
    // `accepted: false` is a successful call that queued nothing. Treating it as done is how an
    // index stops receiving writes while every request still returns 200.
    const { engine, writes } = recordingEngine();
    const indexed = searchableIndexer({ engine, queue: recordingQueue(false) });

    const error: unknown = await indexed
      .index({ id: 'doc-1', fields: { title: 'x' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TsirError);
    expect((error as TsirError).code).toBe('CAP_DISPATCH_FAILED');
    expect(writes).toEqual([]);
  });

  test('a dispatch that throws keeps its cause and names the job', async () => {
    const { engine } = recordingEngine();
    const boom = new Error('connection refused');
    const queue: SearchJobDispatcher = {
      dispatch() {
        return Promise.reject(boom);
      },
    };
    const indexed = searchableIndexer({ engine, queue });

    const error: unknown = await indexed.remove('doc-1').catch((e: unknown) => e);
    expect((error as TsirError).code).toBe('CAP_DISPATCH_FAILED');
    expect((error as TsirError).message).toContain(SEARCH_REMOVE_JOB);
    expect((error as TsirError).cause).toBe(boom);
  });
});
