# Tasks — `@tsir/queue` (Phase 7)

> One port, named connections, and the reliability features Gate P7 makes **mandatory** rather
> than optional: retries with backoff, a dead-letter table with a replay command, idempotency
> keys, and a graceful drain bounded by `shutdownTimeoutMs`.
>
> **Plan:** [`15-capabilities.md § 4.2`](../modules/15-capabilities.md) (drivers, the outbox argument,
> the trigger table) and [`decisions/0027`](../decisions/0027-capability-drivers.md) (packaging,
> app-supplied clients, registries).

**Status: complete — five drivers, `queue:*`, the conformance kit, one trigger per connection in
the deploy graph, and the outbox _rule_. The outbox's writer now lives in `@tsir/events`
(`QUEUE-18`, [`events.md`](./events.md)): the queue knows what a message is, and the events package
knows what a delivery means.**

## Tasks

| ID         | Task                                                                        | Status | Depends                    | Acceptance                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------- | ------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUE-1`  | Port: `push`/`reserve`/`complete`/`fail`/`dead`/`replay`/`discard`          | `[x]`  | `CAP-001`                  | `attempts` on a reserved message counts the attempt it starts; a lease is a promise                                                                                   |
| `QUEUE-2`  | `defineJob` + registry (`maxAttempts`, `backoff`, `timeoutMs`, `retryable`) | `[x]`  | `QUEUE-1`                  | A duplicate job name is a `TypeError` at registry creation, not a coin flip at dispatch                                                                               |
| `QUEUE-3`  | `createQueue`: `dispatch`/`dispatchMany`/`dispatchLater`/`cancel`           | `[x]`  | `QUEUE-2`                  | Unknown job → `CAP_UNKNOWN_JOB`; undeclared connection → `CAP_UNKNOWN_CONNECTION`, never the default                                                                  |
| `QUEUE-4`  | `createWorker`: lease, concurrency, drain on `SIGTERM`                      | `[x]`  | `QUEUE-3`                  | `stop()` stops reserving, waits `shutdownTimeoutMs`, then reports what it abandoned                                                                                   |
| `QUEUE-5`  | Exponential backoff with jitter, injected clock                             | `[x]`  | `QUEUE-2`                  | `min(maxMs, base·factor^(n-1))` ± jitter; attempt 1 is the base delay; tests never sleep                                                                              |
| `QUEUE-6`  | Dead-letter store + replay + discard (`queue:failed`, `queue:retry`)        | `[x]`  | `QUEUE-3`                  | `retryable: false` and the last attempt dead-letter with the error; a replay resets the budget                                                                        |
| `QUEUE-7`  | Idempotency keys                                                            | `[x]`  | `QUEUE-3`                  | Two dispatches with one key deliver once — a partial unique index on the SQL driver                                                                                   |
| `QUEUE-8`  | `memory` driver                                                             | `[x]`  | `QUEUE-1`                  | Full lifecycle (lease, delay, dead letter, replay) with `persistent: false`; refused in production                                                                    |
| `QUEUE-9`  | `sync` driver                                                               | `[x]`  | `QUEUE-1`                  | Runs inside `dispatch`; `delay: false` and no `cancel`; refused in production                                                                                         |
| `QUEUE-10` | `database` driver (Postgres `SKIP LOCKED`, D1 single-statement claim)       | `[x]`  | `QUEUE-1`                  | Dialect from `capabilities`, never guessed; `queue:table` prints the DDL the driver issues                                                                            |
| `QUEUE-11` | Transactional outbox (`record`, `pending`, `markPublished`, `relay`)        | `[x]`  | `QUEUE-1`                  | `record(message, statement)` joins the caller's `batch()`; the relay keeps the message id                                                                             |
| `QUEUE-12` | `queue.connections` in `tsir.js` + `createQueues`                           | `[x]`  | `QUEUE-3`                  | Unknown driver → `CAP_DRIVER_MISSING` listing the shipped ones; `memory`/`sync` refused in production                                                                 |
| `QUEUE-13` | `tsir queue:*` (`work`, `failed`, `retry`, `table`)                         | `[x]`  | `QUEUE-12`                 | `--connection` is required to be declared; `work --once` exits non-zero on a dead letter                                                                              |
| `QUEUE-14` | Conformance kit (`@tsir/queue/conformance`)                                 | `[x]`  | `QUEUE-8`                  | Ships as data, no test framework; every shipped driver runs it, and the kit fails a broken driver                                                                     |
| `QUEUE-15` | `cloudflare-queues` driver + mandatory D1 outbox                            | `[x]`  | `QUEUE-11`, `CAP-004`      | Default on Workers; `createQueues` **and** `tsir build` refuse it without `outbox: true`                                                                              |
| `QUEUE-16` | `sqs` driver (poller on Bun, event source on Lambda)                        | `[x]`  | `QUEUE-11`, `CAP-004`      | FIFO refuses `DelaySeconds` (so `delay: false`); the outbox is mandatory; `idempotency: fifo`                                                                         |
| `QUEUE-17` | One trigger per connection in the deploy graph                              | `[x]`  | `QUEUE-15`, `08-deploy.md` | A connection with no trigger on the chosen target fails `tsir build` (`DPL_QUEUE_TRIGGER_MISSING`); so does a broker with no outbox                                   |
| `QUEUE-18` | `@tsir/events` and the shared outbox                                        | `[x]`  | `QUEUE-11`                 | The outbox writer moved to `@tsir/events` (`EVT-5`/`EVT-6`); `tsir build` refuses a broker connection whose project exports no registry (`DPL_EVENTS_OUTBOX_MISSING`) |

## As built: the port and the worker (`QUEUE-1`, `QUEUE-4`)

The lifecycle is the design, and everything else is bookkeeping around it:

```
push ──▶ reserved ──▶ complete
           │  └────▶ fail ──▶ (retryAt) ──▶ push
           └───────▶ dead ──▶ dead-letter table ──▶ `queue:retry`
```

Two decisions are load-bearing:

- **`attempts` on a reserved message counts the attempt being started.** The worker uses that
  number verbatim instead of incrementing again, so the two can never disagree. The
  conformance kit fails a driver that returns `0` here, and it found a real double-count in the
  `memory` driver the day it was written.
- **`start()` never awaits its own work.** A loop that does can never notice `stopping` while a
  job is stuck — which would make `shutdownTimeoutMs` unreachable and turn a graceful drain
  into a hang. `drainOnce()` is the waiting version (for `--once` and for tests); `start()` is
  the unwaiting one, and the difference is the whole point.

Delivery is **at-least-once**, always. `JobContext.id` is stable across retries and exists to
be used as an idempotency key; `at-most-once` is not a mode this package offers, because it is
not a mode a queue can honestly provide.

## As built: the `database` driver (`QUEUE-10`)

The same shape as the cache's SQL driver — an app-supplied `QueueSql` that `@tsir/database`'s
`Database` satisfies structurally — with one extra concern: **the claim.**

| Engine   | Claim                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres | `UPDATE … SET leased_until = $3, attempts = attempts + 1 WHERE id IN (SELECT … LIMIT $4 FOR UPDATE SKIP LOCKED) RETURNING *`                 |
| D1       | the same statement without `FOR UPDATE SKIP LOCKED` — D1 has no row locks, and a hint it cannot honour reads as a guarantee it does not make |

Placeholders follow the engine (`?` on D1, `$n` on Postgres) and are asserted on the statements
the driver actually issues, not inferred. Three tables are one schema, printed by
`tsir queue:table`: `queue_jobs` (pending, leased, delayed), `queue_dead` (dead letters),
`queue_outbox` (the transactional outbox). `queue_jobs_idempotency` is a **partial unique
index**, which is what makes an idempotency key a database guarantee rather than a convention.

## As built: the outbox (`QUEUE-11`)

D1 has no interactive transactions, so a job cannot be enqueued inside the write that caused
it. `batch()` is atomic, so the business row and the outbox row commit together, and a relay
publishes what committed:

```ts
await db.batch([
  db.insert(orders).values(order),
  outbox.record(message, (sql, params) => db.statement(sql, params)),
]);
// …later, in the worker's own tick:
await outbox.relay(queue);
```

- **`record(message, statement)` runs on the caller's batch**, not on a connection of its own.
  A driver that quietly opened its own write would look correct and lose the guarantee.
- **The relay is at-least-once too**: it dispatches with `idempotencyKey = the outbox row id`
  and marks each row published individually, so a crash mid-batch republishes rather than
  skips — and the republish is recognisably the same message.
- **`requireOutbox(connection, driver, transactional, hasOutbox)`** is the build-time refusal
  (`CAP_OUTBOX_REQUIRED`). It exists for `cloudflare-queues` and `sqs` (`QUEUE-15`/`16`), where
  it will be called from the deploy graph rather than from the driver.

## As built: `queue.connections` and `tsir queue:*` (`QUEUE-12`, `QUEUE-13`)

`createQueues` builds one backend per declared connection, **lazily** — except the default,
which is built eagerly, because a production app whose default queue is `memory` must fail at
boot rather than at the first dispatch in a request. `memory` and `sync` are refused under
`production: true` with a message in the units of the harm ("the queue would die with the
process", "the job would run inside the request that dispatched it").

Four commands, each the answer to a question asked with a terminal open:

| Command        | Flags                                                     | Decides                                                                |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `queue:work`   | `--connection`, `--once`, `--concurrency`, `--batch-size` | a worker is configured for a **connection**; `--once` is a gate        |
| `queue:failed` | `--connection`, `--limit`, `--json`                       | a listing, so it exits 0 whether or not the store is empty             |
| `queue:retry`  | `<id>` or `--all`, `--limit`, `--yes`, `--json`           | a replay needs `--yes`: it re-runs real work against real dependencies |
| `queue:table`  | `--engine`, `--table`, `--dead-table`, `--outbox-table`   | the SQL the `database` driver queries, per engine                      |

- `queue:work --once` exits **non-zero when a job dead-letters** — in `--once` mode the command
  _is_ the smoke test a pipeline runs.
- A connection that cannot be drained (`sync`, or `memory` from a CLI process) is refused with
  a reason instead of polling an empty store forever.
- The registry comes from the entry's `queues` export when there is one, otherwise from
  `queue.connections`; jobs from the entry's `jobs`. No registry → the command says so, because
  a worker with no jobs would dead-letter every message it reserved.

The commands are tested as **separate processes**, one per command, sharing a JSON-file broker
(`src/framework/console/src/commands/fixtures/queue-app`). That is the only way the interesting
property — a message written by a request, reserved by a worker, replayed by an operator — can
be observed at all. An in-process test with an in-memory broker would pass and prove nothing.

## As built: the conformance kit (`QUEUE-14`)

`@tsir/queue/conformance` exports `conformanceCases({ driver, config, behaviour })` as data — no
test framework imported, so a third-party driver author can run it under whatever runner they
have. `behaviour: 'inline'` is the `sync` shape (push runs the work, nothing is stored);
`'broker'` is everything else.

The kit asserts the three properties that are invisible until production:

- **a lease is a promise** — hidden while held, returned with the attempt counted when it
  expires;
- **nothing is dropped** — an exhausted message is in the dead-letter store with its error, and
  only a replay or a discard gets it out;
- **`attempts` counts the attempt being started**, because the worker trusts it.

It is proven to have teeth: `conformance.test.ts` runs it against two deliberately broken
drivers (one that loses messages, one that double-counts attempts) and requires the failures.
Writing it found two real bugs in the `memory` driver — a missing connection filter and an
attempt counter that never advanced on a re-lease.

## As built: the two broker drivers (`QUEUE-15`, `QUEUE-16`)

Both take an app-supplied client (ADR-0027 § 1), so neither the Cloudflare SDK nor the AWS SDK
becomes a dependency — `make deps` is still 2. Both are **push or poll on the platform's
terms**, and the port is bridged, not bent:

|                     | `cloudflare-queues`                                                      | `sqs`                                                                                                       |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| reaching the worker | `deliver(batch)` ← the `queue()` handler, then `reserve()` from an inbox | `receiveMessage` with the lease as the visibility timeout                                                   |
| retry               | `retry({ delaySeconds })`, computed by the worker                        | `changeMessageVisibility(delaySeconds)`                                                                     |
| delay ceiling       | 12 h — **refused past it**, never clamped                                | 900 s on a standard queue; **FIFO refuses `DelaySeconds` entirely**, so `fifo: true` reports `delay: false` |
| order               | `ordered: false`                                                         | `ordered: fifo`                                                                                             |
| idempotency         | `false` — Queues accepts the same body twice                             | `fifo` — dedupe lives on `MessageDeduplicationId`                                                           |
| dead letters        | `queue_dead` in SQL, when a client is supplied                           | the same table, same reason                                                                                 |

Three things that only showed up when the drivers met the conformance kit:

- **The lease is the platform's.** The kit grew `behaviour: 'platform'` rather than pretending
  a driver owns a visibility timeout it does not: it still proves delivery, acknowledgement,
  dead letters and idempotency honesty, and the platform's own clock is tested where it lives —
  against a fake platform, in the driver's own tests.
- **`idempotency` became a capability.** Neither broker dedupes, and a dispatch that carries a
  key to a backend which ignores it looks exactly like one that worked. So the flag now exists,
  the kit asks for what the backend promises, and `sqs` reports it only on FIFO.
- **The queue is the address.** The first Queues driver filtered reserved messages by the
  payload's `connection`; a Worker consuming one queue would then strand a message whose
  producer wrote another name — accepted, never run, invisible except as a queue that never
  drains. `reserve` ignores the connection on a push-driven driver, and the kit has a case for
  that instead of the `database` driver's filtering case.

## As built: the registry's `required` flag

`queue.connections.<name>.required: true` builds that connection at boot, so a production app
whose cron drains a `memory` connection refuses to start instead of throwing at the first tick.
Without it the flag was declared and never read — an option that looks like it validates and
does not, which is the same defect class as a backend that accepts an idempotency key and
ignores it. Everything unnamed stays lazy, so declaring a connection nobody resolves still costs
nothing.

## As built: one trigger per connection (`QUEUE-17`, `CAP-004`)

`queue.connections` is graph input, so each connection becomes a unit named `queue:<name>`
whose triggers come from the § 4.2 matrix — and the matrix is data (`QUEUE_TRIGGER_MATRIX`),
not a comment:

| Driver              | Bun        | Workers                     | Lambda                      |
| ------------------- | ---------- | --------------------------- | --------------------------- |
| `database`          | drain loop | `scheduled` → bounded batch | EventBridge → drain         |
| `cloudflare-queues` | —          | native `queue` handler      | —                           |
| `sqs`               | poller     | —                           | native event source mapping |

Two refusals, both at build time, both naming the cell they came from:

- **`DPL_QUEUE_TRIGGER_MISSING`** — `cloudflare-queues` on `lambda` says so, and says where the
  driver _does_ run, so the fix is one decision away.
- **`DPL_QUEUE_OUTBOX_MISSING`** — a non-transactional driver without `outbox: true`. The
  failure this prevents is not a crash: it is an order that committed with no receipt job, or a
  receipt job for an order that rolled back. `createQueues` refuses the same pairing at boot,
  so the two checks agree.

The **Bun column is a documented absence**: `@tsir/deploy` emits platform artefacts and Bun has
none, so a drain there is `tsir queue:work --connection=<name>` under the same supervisor that
keeps the HTTP process alive (`make dev`/`kill` in development). The graph still records the
trigger, because that record is what makes `checkGraph`, the console and this table agree; the
run command belongs to the app rather than to a generated file.

A graph is one artefact for every target, so a unit's triggers are the **union across targets**
(`sqs` carries both a cron and a queue trigger) and `checkGraph` refuses the impossible pairings
per target. The emitters follow: `[[queues.consumers]]` and `[triggers] crons` in
`wrangler.toml`, an SQS event source in the SAM template. A trigger the graph records and the
emitter forgets is a unit the dashboard shows and the platform never calls.

## What is deliberately not here

`@tsir/events` (`QUEUE-18`) is the next package, and it is where the outbox belongs as a
first-class thing rather than a module of the queue: the events package will own the
`record`/`relay` pair and the listeners that ride on it. `tsir build`'s refusal of `sqs`
without it is therefore _not_ implemented yet — the rule the build enforces today is the one
that is true today (`outbox: true` on the connection), and the package-level rule lands with
the package instead of being written twice.
