# Search

After [installation](../installation.md), add the package to your app with
`bun add '@tsir/scout@workspace:*'`.

## Why this port exists, and why it is the one with a third party in it

Full-text search over six engines — FTS5 and `tsvector` in the database you already have, three
hosted services when the corpus outgrows it, and a `Map` for tests — behind one three-method port, so
moving between them is a config line rather than a rewrite.

Every other capability in Tsir has a real answer on both clouds. Search does not: Cloudflare has no
search product (`env.SEARCH` does not exist), D1's FTS5 is real but is a table scan's cousin once the
corpus outgrows one database, and AWS's answer is OpenSearch — a cluster to size, secure and pay for
before the first query.

So search has six engines and they fall into three groups:

| Group                            | Engines                                  | Where it runs               |
| -------------------------------- | ---------------------------------------- | --------------------------- |
| In the process                   | `memory`                                 | tests, `tsir dev`           |
| In the database you already have | `sqlite` (FTS5), `postgres` (`tsvector`) | any target with that engine |
| At a hosted service              | `typesense`, `meilisearch`, `algolia`    | anywhere — they are HTTP    |

The port exists so the choice is a config line rather than a rewrite. Start on `sqlite` because it
costs nothing, move to `typesense` when the corpus grows, and application code does not change.

## The port is three methods

```ts
interface SearchEngine {
  index(doc: { id: string; fields: Record<string, string> }): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: string, limit?: number): Promise<{ id: string; score: number }[]>;
}
```

Four things it promises, because the conformance kit enforces them:

- **A query with no terms returns nothing.** An empty search box that returns the whole corpus is the
  classic search bug, and it is invisible in a test that only searches real words.
- **`remove` is idempotent.** Deletes are retried — a redelivered job, a webhook sent twice — so
  removing an absent document is a success. A hosted API answers `404` for it, and the driver
  swallows that one status and no other.
- **Re-indexing replaces.** The same `id` twice is one document with the new fields. A driver that
  appends leaves a stale title in the results.
- **`limit` is a cap**, not a suggestion.

This example runs on the in-process engine, so it needs no service:

```ts verify
import { memoryEngine } from '@tsir/scout';

const engine = memoryEngine();
await engine.index({ id: 'post-1', fields: { title: 'Deploying to Workers', body: 'wrangler' } });
await engine.index({ id: 'post-2', fields: { title: 'Postgres indexes', body: 'B-tree' } });

const hits = await engine.search('workers');
console.log(hits.map((hit) => hit.id)); // ['post-1']

// Empty query, empty result — not everything.
console.log((await engine.search('   ')).length); // 0

// Removing twice is not an error.
await engine.remove('post-1');
await engine.remove('post-1');
```

## Choosing a driver in `tsir.js`

The driver is named in config, not wired in the entry — that is what lets the production refusal
run at boot (`CAP-006`). Hover over a section in [drivers](../guides/drivers.md) for the map of what
each target defaults to.

```ts
// config/search.ts
export default {
  default: 'main',
  engines: {
    main: {
      driver: 'typesense',
      host: 'https://xxx.a1.typesense.net',
      apiKey: { fromEnv: 'TYPESENSE_API_KEY' },
      collection: 'posts',
    },
  },
};
```

`memory` is refused once `APP_ENV=production` (`CAP_FORBIDDEN_IN_PRODUCTION`): it is a `Map` in one
process, so on a Worker nothing survives the request and on a fleet every instance has a different
index.

## The engines that live in your database

`sqlite` and `postgres` need a query function, which `@tsir/database`'s connection satisfies
structurally — no driver import, so the engine never has to know which database it is talking to.

```ts
import { databaseQuery, postgresEngine } from '@tsir/scout';
import { databases } from './database.ts';

const engine = postgresEngine(databaseQuery(databases.defaultDatabase));
```

Both engines read a `search_index` table (`id`, `content`); `postgresEngine` writes
`to_tsvector`/`plainto_tsquery` against it and `sqliteEngine` writes FTS5 `bm25()`. Create the table
before first use — the package pages carry the DDL for each engine.

`sqliteEngine` needs FTS5 compiled into the SQLite build. Node's bundled SQLite has it; a custom
build may not. The failure arrives on the first statement (`no such module: fts5`), which is late
enough to be annoying and early enough to be unambiguous — if you are on a minimal build, use
`postgres` or a hosted engine instead.

## The hosted engines: one function, three wire shapes

`typesense`, `meilisearch` and `algolia` all speak REST with an API key, which is why they share
`hostedSearch()` and differ only in the adapter. There is no SDK dependency — a driver that pulled
one in would be a driver that could not run on a Worker without bundling a Node client.

```ts
import { hostedSearch } from '@tsir/scout';

const engine = hostedSearch({
  provider: 'meilisearch',
  host: 'https://ms-xxx.meilisearch.io',
  apiKey: { fromEnv: 'MEILISEARCH_API_KEY' }, // never the key itself
  collection: 'posts',
});
```

A key written as `{ fromEnv }` is resolved at construction. A key that is `undefined` there refuses
at boot, and the error never echoes it — `HostedSearchError` names the provider and the operation.

**Algolia's app id comes from the hostname** and is validated: `https://<APP_ID>-dsn.algolia.net`.
That is why a made-up host fails at construction rather than at the first write.

## Keeping the index off the request path

`index()` and `remove()` are network calls to a service nobody reads until a later search. Wrapping
the engine in `searchableIndexer` turns those two into queue jobs, so the request returns once the
job is accepted; `search()` is untouched, because it is the one call that is on the request path.

```ts
import { searchableIndexer } from '@tsir/scout';
import { queues } from './queues.ts'; // any object with a `dispatch` method

const indexed = searchableIndexer({ engine, queue: queues.connection() });
await indexed.index({ id: 'post-1', fields: { title: 'Hello' } }); // queued, not written
await indexed.search('hello'); // still immediate
```

The same object is a `SearchEngine`, so nothing that takes an engine needs to know. Register a handler
for each job name in the worker — the handler is what closes the loop:

```ts
import { defineJob } from '@tsir/queue';
import { SEARCH_INDEX_JOB, SEARCH_REMOVE_JOB, type IndexJobPayload } from '@tsir/scout';

export const SearchIndexJob = defineJob<IndexJobPayload>({
  name: SEARCH_INDEX_JOB,
  handle: ({ payload }) => engine.index({ id: payload.id, fields: payload.fields }),
});
```

`queue` is any object with a `dispatch` method — `@tsir/queue`'s `Queue` satisfies it, and `scout`
cannot import it (`check-boundaries`), which is why the seam is structural. Pass `inline: true` when
there is no worker, such as a one-off backfill.

**A dispatch that is not accepted throws.** `accepted: false` means the message was de-duplicated or
dropped; treating it as done is how an index silently stops receiving writes while every request
still returns `200`. And there is no local fallback: a write that appears to succeed and is not
indexed is a document that exists and cannot be found.

Ordering is not guaranteed. Two jobs for one id may run in either order, which is why `index` and
`remove` are idempotent and the last state wins rather than the last call — a re-index of a since
deleted document brings it back. If that matters, give each document id one connection, or index from
a single writer.

## Writing your own engine

Run the conformance kit. It is case data rather than a test suite, so it works under whatever runner
you already use:

```ts
import { conformanceCases } from '@tsir/scout/conformance';
import { test } from 'bun:test';

for (const conformanceCase of conformanceCases({ engine: myEngine(), prefix: 'myengine-kit' })) {
  test(conformanceCase.name, () => conformanceCase.run());
}
```

`prefix` is required, not defaulted: the kit writes real documents, and against a hosted engine it
writes to a real collection. A shared default would have two concurrent runs deleting each other's
fixtures.

The kit checks matching, replacement, idempotent removal, the empty query and the limit. It
**does not** check ranking quality or score values — the engines rank by lexical match, typo
tolerance and vector proximity respectively, so a kit that pinned a score would be a kit only one
engine passes.

## Failure modes

| Code                          | When     | What it means                                                                                                                                                                   |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAP_DRIVER_MISSING`          | Boot     | An unknown `driver`, or a `typesense` engine with no `host`. The hint lists what the build ships.                                                                               |
| `CAP_FORBIDDEN_IN_PRODUCTION` | Boot     | `memory` with `APP_ENV=production`.                                                                                                                                             |
| `HostedSearchError`           | Any call | A non-2xx, a timeout, or a 200 whose body is not JSON — which means a proxy in front of the provider, not the provider. It names the provider and the operation, never the key. |

A `404` on `remove` is **not** in that table on purpose: it is a success, because the document is
gone and that is what the caller asked for.
