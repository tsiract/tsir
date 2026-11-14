/**
 * Queue-backed indexing (`SRCH-7`).
 *
 * `engine.index()` and `engine.remove()` are `Promise`s that hit a remote service. Calling them
 * inline inside a request is correct and slow: the write waits for an index that nobody reads until
 * a later search. This wraps an engine so those two calls become **queue jobs** and the request
 * returns as soon as the job is accepted. `search()` is untouched — it is read on the request path
 * and must never be deferred.
 *
 * ## Why the queue arrives structurally
 *
 * `@tsir/scout` may not import `@tsir/queue` (`check-boundaries`): a search engine that depends on a
 * job runner can no longer be used by a CLI script that has no worker, and the dependency would be
 * paid by every project that only wants FTS5. So the caller hands over an object with a `dispatch`
 * method — exactly the shape the hosted engines use for their HTTP clients, and for the same reason.
 * The app's own `Queue` satisfies it; so does a test double that records calls.
 *
 * ## What is deliberately not here
 *
 * **No local fallback.** If the dispatch throws, the index does not quietly run inline. A write that
 * appears to succeed and is not indexed produces a document that exists and cannot be found — the
 * failure nobody reports, because the write returned 200. It throws `CAP_DISPATCH_FAILED` instead,
 * which the caller can retry, and `@tsir/events` already answers this shape properly with an outbox.
 *
 * **No ordering guarantee.** Two jobs for one id may run in either order, so `index` and `remove` are
 * written to be idempotent (`SRCH-1`), and the last state wins rather than the last *call*. A
 * re-index of a document that was since deleted is a document that reappears; if that matters, pass
 * one `connection` per document id or index from a single writer.
 */

import { TsirError } from '@tsir/container';
import type { SearchDocument, SearchEngine } from './scout.ts';

/** The payload a `tsir.search.index` job carries. JSON, so the fields are strings. */
export interface IndexJobPayload {
  readonly id: string;
  readonly fields: Record<string, string>;
}

/** The payload a `tsir.search.remove` job carries. */
export interface RemoveJobPayload {
  readonly id: string;
}

/**
 * The queue seam. `@tsir/queue`'s `Queue` satisfies it; a project that dispatches by another means
 * can too. `dispatch` must resolve once the message is durably accepted, not once it ran.
 */
export interface SearchJobDispatcher {
  dispatch(
    job: { readonly name: string },
    payload: IndexJobPayload | RemoveJobPayload,
    options?: { readonly idempotencyKey?: string | undefined },
  ): Promise<{ readonly accepted: boolean; readonly id?: string }>;
}

/** The names that travel. Exported so a worker can register a handler for each. */
export const SEARCH_INDEX_JOB = 'tsir.search.index';
export const SEARCH_REMOVE_JOB = 'tsir.search.remove';

export interface SearchIndexerOptions {
  /** The engine that will actually do the work, inside the job handler. */
  readonly engine: SearchEngine;
  /** Where the work is dispatched. The app's `Queue` satisfies this. */
  readonly queue: SearchJobDispatcher;
  /**
   * `true` refuses to defer at all and calls the engine inline. It exists for a CLI script or a
   * one-off backfill where no worker will ever run, and it is explicit for that reason: silently
   * choosing it when a dispatch fails is how a document goes missing.
   */
  readonly inline?: boolean | undefined;
}

/**
 * An engine whose writes are queued. `search()` delegates directly.
 *
 * The returned object is a `SearchEngine`, so it is a drop-in: nothing that takes an engine can
 * tell whether writes are deferred.
 */
export function searchableIndexer(options: SearchIndexerOptions): SearchEngine {
  const { engine, queue, inline = false } = options;

  return {
    async index(doc: SearchDocument): Promise<void> {
      if (inline) {
        await engine.index(doc);
        return;
      }
      await deliver(
        queue,
        { name: SEARCH_INDEX_JOB },
        { id: doc.id, fields: { ...doc.fields } },
        // One id, one pending write: a second index of the same document before the first runs is
        // the same work. `remove` gets its own key so it cannot be dropped as a duplicate of an
        // index for the same id — the pair must both run.
        { idempotencyKey: `search:index:${doc.id}` },
        doc.id,
      );
    },

    async remove(id: string): Promise<void> {
      if (inline) {
        await engine.remove(id);
        return;
      }
      await deliver(
        queue,
        { name: SEARCH_REMOVE_JOB },
        { id },
        { idempotencyKey: `search:remove:${id}` },
        id,
      );
    },

    search(query: string, limit?: number) {
      // Never queued. A search that returns a promise to search later is a feature nobody asked for.
      return engine.search(query, limit);
    },
  };
}

/**
 * Dispatch, and refuse if the backend dropped the message.
 *
 * `accepted: false` is a *successful* call that enqueued nothing — a de-duplicated message, or a
 * connection that could not take it. Treating it as done is how an index silently stops receiving
 * writes, so it is an error here with the job name in it.
 */
async function deliver(
  queue: SearchJobDispatcher,
  job: { readonly name: string },
  payload: IndexJobPayload | RemoveJobPayload,
  options: { readonly idempotencyKey: string },
  documentId: string,
): Promise<void> {
  let accepted: boolean;
  try {
    ({ accepted } = await queue.dispatch(job, payload, options));
  } catch (cause) {
    throw new TsirError(
      'CAP_DISPATCH_FAILED',
      `search: could not queue \`${job.name}\` for document "${documentId}"`,
      {
        kind: 'capability',
        hint: 'the index write was not queued — retry it, or build the indexer with `inline: true` if no worker will ever run',
        context: { job: job.name, documentId },
        cause,
      },
    );
  }

  if (!accepted) {
    throw new TsirError(
      'CAP_DISPATCH_FAILED',
      `search: \`${job.name}\` for document "${documentId}" was not accepted by the queue`,
      {
        kind: 'capability',
        hint: `the backend dropped the message as a duplicate of \`${options.idempotencyKey}\` — it is already queued, so the write will land`,
        context: { job: job.name, documentId, idempotencyKey: options.idempotencyKey },
      },
    );
  }
}
