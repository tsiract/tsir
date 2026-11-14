/**
 * `@tsir/scout`'s queue seam against the real `Queue` (`SRCH-7`).
 *
 * This lives in an application, not in the package, and that is the point. `@tsir/scout` may not
 * import `@tsir/queue` (`check-boundaries`): a search engine that depends on a job runner cannot be
 * used by a CLI that has no worker, and every project would pay for a queue it never runs. So the
 * seam is a structural type — `{ dispatch }` — and the only place both packages can be imported
 * together to prove it fits is an app that depends on both. This one does.
 *
 * Without this test the seam would be a shape that looks right and was never tried, which is how a
 * structural type becomes an adapter nobody can write.
 */
import { describe, expect, test } from 'bun:test';
import { createQueues, defineJob, type Queue } from '@tsir/queue';
import {
  SEARCH_INDEX_JOB,
  memoryEngine,
  searchableIndexer,
  type IndexJobPayload,
  type SearchJobDispatcher,
} from '@tsir/scout';

describe('scout × queue', () => {
  test('a real Queue satisfies SearchJobDispatcher with no adapter and no cast', async () => {
    const seen: string[] = [];
    const indexJob = defineJob<IndexJobPayload>({
      name: SEARCH_INDEX_JOB,
      handle: ({ payload }) => {
        seen.push(payload.id);
      },
    });
    const queues = createQueues({
      queue: { default: 'default', connections: { default: { driver: 'memory' } } },
      jobs: [indexJob],
    });

    // The compile-time claim under test: assigning the connection must typecheck. If the seam ever
    // drifts from `Queue`, this line stops compiling rather than failing at runtime in a user's app.
    const connection: Queue = queues.connection();
    const queue: SearchJobDispatcher = connection;

    const indexed = searchableIndexer({ engine: memoryEngine(), queue });
    await indexed.index({ id: 'doc-1', fields: { title: 'Hello' } });

    expect(seen).toEqual([]); // queued, not run: the request has already returned
    await queues.worker().drainOnce();
    expect(seen).toEqual(['doc-1']);
  });

  test('a queued index reaches the engine through the job handler', async () => {
    // The end-to-end shape a project writes: the handler is what closes the loop, so a driver that
    // dispatches but never handles is an index that silently stops updating.
    const engine = memoryEngine();
    const indexJob = defineJob<IndexJobPayload>({
      name: SEARCH_INDEX_JOB,
      handle: async ({ payload }) => {
        await engine.index({ id: payload.id, fields: payload.fields });
      },
    });
    const queues = createQueues({
      queue: { default: 'default', connections: { default: { driver: 'memory' } } },
      jobs: [indexJob],
    });

    const indexed = searchableIndexer({ engine, queue: queues.connection() });
    await indexed.index({ id: 'doc-1', fields: { title: 'Hello there' } });
    expect(await engine.search('hello')).toEqual([]);

    await queues.worker().drainOnce();
    expect((await engine.search('hello')).map((r) => r.id)).toEqual(['doc-1']);
  });
});
