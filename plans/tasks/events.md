# Tasks — `@tsir/events` (Phase 7)

> Typed events, and the transactional outbox that makes a queued delivery as durable as the write
> that caused it. The queue landed first (`QUEUE-11`) precisely so this package could own the
> writer instead of describing it: a broker enqueue is a second write, and the outbox is the only
> place the business row and its consequences share a transaction.
>
> **Plan:** [`15-capabilities.md § 4.5`](../modules/15-capabilities.md) · **Published by:** `QUEUE-18` in
> [`queue.md`](./queue.md) · **Related:** [`decisions/0016`](../decisions/0016-cloudflare-first-and-d1.md)
> (§ 1.5, the D1 outbox).

**Status: complete.** Six tasks, four source modules, four test files; `tsir build` refuses a
broker connection whose project exports no events registry (`DPL_EVENTS_OUTBOX_MISSING`).

## Tasks

| ID      | Task                                                                       | Status | Depends             | Acceptance                                                                                                             |
| ------- | -------------------------------------------------------------------------- | ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `EVT-1` | `defineEvent` — a dotted name and a payload type, validated at declaration | `[x]`  | —                   | A name that is not dotted lowercase is a `TypeError`, because the name becomes a job name, a log field and a row       |
| `EVT-2` | `defineListener` — one handler for one event, with a declared `mode`       | `[x]`  | `EVT-1`             | A listener inherits the event's mode until it declares its own; two listeners with one name is refused at the bus      |
| `EVT-3` | `createEvents` — `dispatch`, `sync` inline and `queued` as a job           | `[x]`  | `EVT-2`, queue      | `sync` runs before `dispatch` resolves and its failure reaches the caller; nothing is queued after that failure        |
| `EVT-4` | `jobs()` — the `queued` half as real `JobDefinition`s                      | `[x]`  | `EVT-3`             | A worker runs a delivery through the normal job path; a `sync` listener produces no job                                |
| `EVT-5` | The outbox writer, moved out of `@tsir/queue`                              | `[x]`  | `EVT-3`, `QUEUE-11` | `record(message, statement)` joins the caller's batch; the relay marks row by row; a `?` engine marks the right row    |
| `EVT-6` | `createPublisher` — `record` + `relay` over the outbox, per delivery       | `[x]`  | `EVT-5`             | One row per `queued` listener inside the caller's `batch()`; a `sync` listener is refused (`CAP_EVENTS_SYNC_OUTBOXED`) |
| `EVT-7` | `tsir build` refuses a broker connection whose project exports no registry | `[x]`  | `EVT-6`, deploy     | `DPL_EVENTS_OUTBOX_MISSING` names the connection and the fix; a project that exports `events` passes                   |

`QUEUE-18` in [`queue.md`](./queue.md) is the same work, published from the queue's side.

## As built: two paths, one set of ids

```
events.dispatch(OrderPlaced, payload)                 sync now, queued as jobs
publisher.record(OrderPlaced, payload, statement)     queued deliveries into the caller's batch
publisher.relay()                                     …after the commit
```

`dispatch` is the fast path and is correct exactly when a lost enqueue costs nothing (a
transactional driver, a dev `memory`/`sync` connection). `record`/`relay` is the durable path and
is what a non-transactional broker requires (§ 4.2). Both produce **the same delivery**: the same
job name (`event:order.placed:send-receipt`), the same JSON envelope, the same `maxAttempts`, and
the same idempotency key — `<dispatchId>:<listener>`. A retry therefore behaves identically
however the event happened to be published, which is the property that makes the two paths safe
to mix.

Three orderings are deliberate:

- **Sync listeners run first, and their failure stops the dispatch.** A queued dispatch is a
  second write; doing it after an inline listener threw is how a receipt job outlives the rollback
  that killed its order. The error names _every_ failing listener, not just the first.
- **`record` refuses a `sync` listener before writing anything.** The relay runs after the
  commit, so an inline listener on an outboxed event has nothing to be inline with.
- **A queued listener with no queue is refused before the sync half runs.** Half a fan-out is
  worse than none, and finding out after the inline half already ran is the worst ordering of all.

## As built: the worker has to know the deliveries exist

A `queued` listener is a job named `event:<event>:<listener>`, and a job name the worker's
registry does not contain is `CAP_UNKNOWN_JOB` — at publish time, hours after the write that was
supposed to be safe. Two wirings, both supported:

```ts
// 1. build the registry yourself, which is what a project with an entry-level `queues` does
export const queues = createQueues({ jobs: [...appJobs, ...events.jobs()] });

// 2. or let the CLI do it: an exported `events` registry contributes its jobs to `queue:work`
```

`tsir queue:work` merges the entry's `jobs` with `events.jobs()` when the entry exports a registry
(`jobsFrom`), deduplicated by name and keeping the app's own definition — an app that already wired
them in is the normal case, and registering one name twice is a `TypeError` at registry creation.
The duck-typed guard means a wrong export is a message, not a crash five minutes into a worker
loop.

## As built: the outbox moved, and the move found a bug

`createOutbox` was `@tsir/queue`'s, shipped one day earlier. It could not stay: a package that
does not know what a delivery is cannot own the writer, and "`tsir build` refuses a broker without
`@tsir/events`" would have been a rule with an obvious workaround. So the writer moved here —
keeping the table (`queue_outbox`), the DDL (`tsir queue:table`), and the semantics — and `queue`
kept only what it can check alone: a non-transactional connection with `outbox: false` is a boot
error (`CAP_OUTBOX_REQUIRED`, tested through `createQueues`).

The move is what caught the bug. `markPublished` numbered its placeholders `p(2)`/`p(1)` while
passing `[id, stamp]`:

```ts
// before — correct for `$n`, inverted for `?`
(`UPDATE ${table} SET published_at = ${p(2)} WHERE id = ${p(1)} …`, [id, stamp]);
```

On Postgres that is `SET published_at = $2 WHERE id = $1` — right. On **D1, the default database
of the default stack**, both placeholders are `?`, so the row was marked `published_at = '<uuid>'`
on an id equal to the timestamp: nothing matched, `RETURNING id` returned nothing, and the relay
re-sent the same row every tick — forever, silently, with `queue:failed` showing nothing because
nothing had failed. The parameters now follow the placeholders (`[stamp, id]` with `p(1)`/`p(2)`),
and a test pins both engines.

Why it survived a day: the old fake read the params array as a list, so it "passed" whichever way
the SQL was written. The new test asserts the **statement text** for a `?` engine and a `$n`
engine, which is the only version of the test a real database would have written.

## As built: the build rule (`DPL_EVENTS_OUTBOX_MISSING`)

`outbox: true` is a durability claim, and it is only true when something writes the table. The
writer is `@tsir/events`' publisher, and the registry is how a project says it has one, so the app
entry must **export** it:

```ts
// src/index.ts — the export name is the contract
export const events = createEvents({ listeners: [...] });
```

`deploymentOf` reads `project.exports['events']` (from the entry the loader already imported — a
second import would register controllers twice, `RTR_DUPLICATE`) and hands the boolean to the
graph. Then, per non-transactional connection, the build reports exactly one problem:

| State                              | Code                        | The repair                                              |
| ---------------------------------- | --------------------------- | ------------------------------------------------------- |
| no `outbox: true`                  | `DPL_QUEUE_OUTBOX_MISSING`  | declare the outbox and write it in the caller's batch   |
| `outbox: true`, no `events` export | `DPL_EVENTS_OUTBOX_MISSING` | export the registry, publish through `publisher.record` |

Both are returned rather than thrown, so one build prints every problem it found. The two are
mutually exclusive per connection on purpose: "declare an outbox" already implies a writer, and
one repair should be one line.

## Rules that apply to every module here

- **A name is an address.** An unknown event is `CAP_UNKNOWN_EVENT`; an unknown listener name
  cannot exist, because the job name is derived from both halves.
- **Refusal beats a quiet approximation.** `sync`-on-the-outbox and `queued`-with-no-queue are both
  refused at the point a person can still fix them, not at the point they would be noticed.
- **The outbox is at-least-once, and says so.** A crash between `dispatch` and `markPublished`
  republishes; the row id is the idempotency key, which is what makes the second publish harmless.
- **Nothing here reads `NODE_ENV`,** opens a client, or imports a runtime built-in: the bus is a
  registry, a dispatch and a Map (`check-boundaries` holds it to Web standards).
