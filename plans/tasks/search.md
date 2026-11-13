# Tasks — `@tsir/search` (← scout) (Phase 10)

> Full-text search abstraction. The engine is ORM-agnostic: callers supply documents and a query,
> the engine answers with ranked ids. Three drivers already ship — `memoryEngine`, `sqliteEngine`
> (FTS5), and `postgresEngine` (`tsvector`) — so a generated app has search on day one without an
> external service. The remaining work is the hosted engines (Algolia, Meilisearch, Typesense) and
> the queue-driven sync that keeps an index fresh without blocking a request.
>
> **Plan:** [`15-capabilities.md`](../modules/15-capabilities.md) · **Related:** [`queue.md`](./queue.md)
> (queue sync), [`04-database.md`](./04-database.md) (SQLite/Postgres engines).

**Status: in progress.** The engine port, six drivers and the conformance kit are complete. One
feature remains: the queue-driven sync.

## Tasks

| ID       | Task                                                             | Status | Depends         | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------- | ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SRCH-1` | Engine port — `index`/`remove`/`search`, `SearchDocument`/result | `[x]`  | —               | `memoryEngine` passes the conformance kit; a query with no terms returns `[]`; `remove` is idempotent                                                                                                                                                                                                                                                                                                                                                                                        |
| `SRCH-2` | `sqliteEngine` — FTS5 virtual table                              | `[x]`  | `SRCH-1`        | Tokenizer configurable; `search` returns ranked `ts_rank`; a missing FTS5 extension is a startup error, not a runtime one                                                                                                                                                                                                                                                                                                                                                                    |
| `SRCH-3` | `postgresEngine` — `tsvector`/`tsquery`                          | `[x]`  | `SRCH-1`        | `to_tsvector` + `plainto_tsquery`; caller supplies the query function so the engine never imports a driver                                                                                                                                                                                                                                                                                                                                                                                   |
| `SRCH-4` | `algoliaEngine` — app-supplied `AlgoliaLike` client              | `[x]`  | `SRCH-1`        | Shipped as `hostedSearch({ provider: 'algolia' })` rather than an app-supplied client: the three hosted engines speak REST with an API key, so a `fetch` driver needs no SDK and no adapter object, and one function serves all three. `objectID` out, two-key auth, app id read from the hostname                                                                                                                                                                                           |
| `SRCH-5` | `meilisearchEngine` — app-supplied `MeilisearchLike` client      | `[x]`  | `SRCH-1`        | Shipped as `hostedSearch({ provider: 'meilisearch' })`. Bearer token, an array body (an object is silently rejected by Meilisearch), and hits read by position because it exposes no score                                                                                                                                                                                                                                                                                                   |
| `SRCH-6` | `typesenseEngine` — app-supplied `TypesenseLike` client          | `[x]`  | `SRCH-1`        | Shipped as `hostedSearch({ provider: 'typesense' })`. `x-typesense-api-key`, per-document `PUT`, `text_match` as the score                                                                                                                                                                                                                                                                                                                                                                   |
| `SRCH-7` | Queue sync — index/remove dispatched as queued jobs              | `[ ]`  | `SRCH-1`, queue | A `searchableIndexer` enqueues `index`/`remove` jobs instead of running them inline; a sync command re-indexes a model                                                                                                                                                                                                                                                                                                                                                                       |
| `SRCH-8` | Engine conformance kit                                           | `[x]`  | `SRCH-1`        | **Found a real bug on its first run:** `remove` threw on a `404`, so a redelivered delete job failed permanently on its second attempt — `SRCH-1`'s own criterion says removal is idempotent, and the hosted engines did not satisfy it. The kit is case data with no test framework (a third-party engine runs it under its own runner), covers empty-query/absent-remove/replace-on-reindex/limit, and is tested against three deliberately broken engines so a case cannot pass vacuously |

## Design notes

**App-supplied clients, not SDKs.** The hosted engines follow the same rule as `@tsir/cache`'s
Redis driver ([ADR-0027](../decisions/0027-capability-drivers.md)): the app passes a client whose
shape the engine names, and the engine refuses at startup if a method is missing. This keeps
`@tsir/search` dependency-free and lets a project pick `algoliasearch`, `meilisearch`,
`typesense`, or a test double.

**Queue sync is optional, not required.** A small app can index inline (the default path); a large
app wires `searchableIndexer` into `@tsir/queue` so a write never blocks on a search round-trip. The
sync is a thin adapter, not a new port: it calls the same `engine.index`/`engine.remove` from a job
handler.

**What the gates check.** `bun test src/framework/scout` covers the engine port and the three
shipped drivers. The hosted engines are verified against fake clients that record calls; the
conformance kit (`SRCH-8`) is the contract every engine must satisfy.
