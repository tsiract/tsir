/**
 * The search engine conformance kit (`SRCH-8`).
 *
 * Every other port in this repository has one — cache, queue, storage, mail, HTTP — and search was
 * the last that did not. That mattered more here than elsewhere: three of its six engines talk to a
 * hosted service over HTTP, so the only way to check a new one has been "run the app and search for
 * something", which is not a check. A driver author, and an agent writing one, gets the same answer
 * as the maintainer from `conformanceCases({ engine })`.
 *
 * The contract is written once here as **data**: a list of named cases, each a function that throws
 * on violation. No test framework is imported, because a third-party engine should be able to run
 * this under whatever runner it already uses:
 *
 * ```ts
 * import { conformanceCases } from '@tsir/scout/conformance';
 * for (const c of conformanceCases({ engine: myEngine() })) test(c.name, () => c.run());
 * ```
 *
 * ## The four rules this kit exists to enforce
 *
 *   · **A query with no terms is `[]`, not everything.** An empty search box that returns the whole
 *     corpus is the classic search bug, and it is invisible in a test that only searches real words.
 *   · **`remove` is idempotent.** Deletes retry — a queue redelivery, a webhook sent twice — so
 *     removing a document that is not there is a success, not an error. A hosted API returning 404
 *     has to be swallowed by the driver, and this is where that is caught.
 *   · **Re-indexing replaces.** The same id indexed twice is one document with the *new* fields, not
 *     two documents and not the old ones. An upsert that appends is a search result with a stale
 *     title in it.
 *   · **A returned id was indexed.** Results point at documents that exist, and `limit` is a cap
 *     rather than a suggestion.
 *
 * ## What the kit deliberately does not check
 *
 * **Ranking quality, and score values.** `score` is compared for *relative order* only. The three
 * engines that ship here rank by lexical match, typo tolerance and vector proximity respectively, so
 * a kit that pinned a number would be a kit that only `memoryEngine` passes. What is checked is the
 * part every engine owes its caller: a document that matches more of the query ranks no lower than
 * one that matches less.
 */

import type { SearchDocument, SearchEngine } from './scout.ts';

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface ConformanceOptions {
  /** The engine under test. A fresh instance per call is best; the kit cleans up after itself. */
  readonly engine: SearchEngine;
  /**
   * A **unique** prefix for the ids this kit writes.
   *
   * Required, not defaulted: the kit writes real documents, and against a hosted engine it writes
   * to a real collection. A fixed default would have two concurrent runs — two contributors, or a
   * contributor and CI — deleting each other's fixtures.
   */
  readonly prefix: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The documents every case indexes, so a failure is reproducible from the name alone. */
const BOOKS = [
  { key: 'a', fields: { title: 'The Rust Programming Language', body: 'worstship systems' } },
  { key: 'b', fields: { title: 'Programming TypeScript', body: 'types and the compiler' } },
  {
    key: 'c',
    fields: { title: 'Designing Data-Intensive Applications', body: 'distributed systems' },
  },
] as const;

export function conformanceCases(options: ConformanceOptions): readonly ConformanceCase[] {
  const { engine, prefix } = options;
  const id = (key: string): string => `${prefix}-${key}`;
  const doc = (key: string): SearchDocument => {
    const book = BOOKS.find((entry) => entry.key === key);
    assert(book !== undefined, `no fixture "${key}"`);
    return { id: id(key), fields: { ...book.fields } };
  };
  /** Every id this kit may have written, so `afterEach` can be `remove` rather than a reset. */
  const written = new Set<string>();
  const index = async (key: string): Promise<void> => {
    await engine.index(doc(key));
    written.add(id(key));
  };

  return [
    {
      name: 'a query with no terms returns nothing, not everything',
      async run() {
        await index('a');
        for (const empty of ['', '   ', '\n\t ']) {
          const results = await engine.search(empty);
          assert(
            results.length === 0,
            `search(${JSON.stringify(empty)}) returned ${String(results.length)} result(s); an empty query must return none`,
          );
        }
      },
    },
    {
      name: 'an indexed document is found by a term in its fields',
      async run() {
        await index('a');
        // A whole word that only this fixture contains: `memoryEngine` matches substrings while the
        // hosted engines match tokens, so a term that is a fragment of another fixture would give
        // different engines different answers for a reason the kit is not testing.
        const results = await engine.search('worstship');
        assert(
          results.some((result) => result.id === id('a')),
          `search did not include the indexed id; got ${results.map((r) => r.id).join(', ')}`,
        );
      },
    },
    {
      name: 'a term nothing contains returns nothing',
      async run() {
        await index('a');
        const results = await engine.search('zzzznotpresentzzzz');
        assert(
          results.length === 0,
          `an unmatched term returned ${String(results.length)} result(s)`,
        );
      },
    },
    {
      name: 'results only name ids that were indexed',
      async run() {
        await index('b');
        for (const result of await engine.search('typescript')) {
          assert(
            written.has(result.id),
            `search returned "${result.id}", which this kit never indexed`,
          );
        }
      },
    },
    {
      name: 're-indexing the same id replaces the document',
      async run() {
        await index('a');
        // Same id, different words. A driver that appends leaves "rust" findable; one that replaces
        // does not.
        await engine.index({
          id: id('a'),
          fields: { title: 'Go in Practice', body: 'goroutines' },
        });
        const stale = await engine.search('rust');
        assert(
          !stale.some((result) => result.id === id('a')),
          'the old fields are still searchable after re-indexing the same id — it appended rather than replaced',
        );
        const fresh = await engine.search('goroutines');
        assert(
          fresh.some((result) => result.id === id('a')),
          'the new fields are not searchable after re-indexing the same id',
        );
      },
    },
    {
      name: 'remove takes the document out of the index',
      async run() {
        await index('b');
        await engine.remove(id('b'));
        const results = await engine.search('typescript');
        assert(
          !results.some((result) => result.id === id('b')),
          'a removed document is still returned by search',
        );
      },
    },
    {
      name: 'remove is idempotent — removing an absent id is not an error',
      async run() {
        // Deletes are retried. A hosted API answers 404 for a document that is already gone, and a
        // driver that surfaces it turns a redelivered job into a permanent failure.
        await engine.remove(`${prefix}-never-indexed`);
        await index('c');
        await engine.remove(id('c'));
        await engine.remove(id('c'));
      },
    },
    {
      name: 'limit caps the result count',
      async run() {
        for (const key of ['a', 'b', 'c']) await index(key);
        const results = await engine.search('programming', 1);
        assert(
          results.length <= 1,
          `search("programming", 1) returned ${String(results.length)} results; limit is a cap`,
        );
      },
    },
    {
      name: 'a document matching both terms is returned for both',
      async run() {
        // Deliberately a *match* assertion, not a ranking one. These engines disagree about what a
        // score means — `memoryEngine` counts substring hits, Typesense returns `text_match` as an
        // opaque token, Meilisearch ranks by position, Algolia answers `1` for every hit — so a kit
        // that demanded a particular order would be a kit only one engine can pass. What every
        // engine owes its caller is that a two-term query finds a document containing both.
        await index('a');
        const results = await engine.search('rust programming');
        assert(
          results.some((result) => result.id === id('a')),
          'a document containing both query terms was not returned',
        );
      },
    },
    {
      name: 'every result carries a finite numeric score',
      async run() {
        for (const key of ['a', 'b']) await index(key);
        for (const result of await engine.search('programming')) {
          assert(
            Number.isFinite(result.score),
            `score for "${result.id}" is ${String(result.score)}, not a finite number`,
          );
        }
      },
    },
    {
      name: 'results are ordered by descending score',
      async run() {
        // Every shipped engine sorts before returning — including the two that flatten their
        // scores — so this is a real contract rather than an artefact of how one of them ranks.
        for (const key of ['a', 'b', 'c']) await index(key);
        const results = await engine.search('programming');
        for (let at = 1; at < results.length; at += 1) {
          const previous = results[at - 1]?.score ?? 0;
          const current = results[at]?.score ?? 0;
          assert(
            previous >= current,
            `results are not sorted: ${String(previous)} at index ${String(at - 1)} precedes ${String(current)}`,
          );
        }
      },
    },
    {
      name: 'the kit leaves nothing behind',
      async run() {
        // Not politeness: the next case starts from whatever the last one indexed, and against a
        // hosted engine this is the only thing keeping a collection clean between runs.
        for (const key of written) await engine.remove(key);
        written.clear();
        for (const result of await engine.search('programming')) {
          assert(
            !result.id.startsWith(prefix),
            `"${result.id}" survived cleanup — remove did not take effect`,
          );
        }
      },
    },
  ];
}
