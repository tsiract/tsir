# Jobs and queues

After [installation](../installation.md), add the package to your app with
`bun add '@tsir/queue@workspace:*'`.

## Why jobs exist

A job is a unit of work that should happen *outside* the HTTP request/response cycle. Sending a
receipt email, processing an uploaded image, or syncing data to a third party — none of these
should make the user wait for a response. In Laravel you would dispatch a `Job` to a queue; in
Tsir you do the same.

The pieces are:

- **A job definition** — `defineJob({ name, handle })`. The `name` is how the worker finds the
  right handler; `handle` is the work.
- **A connection** — the backend that stores pending jobs: `memory` (local only), `database`,
  `cloudflare-queues`, or `sqs`.
- **A worker** — the process that pulls jobs from the connection and runs them.

This local example exercises dispatch and consumption together with the in-memory driver.

```ts verify
import { createQueues, defineJob } from '@tsir/queue';

const SendReceipt = defineJob<{ orderId: string }>({
  name: 'SendReceipt',
  maxAttempts: 3,
  timeoutMs: 5_000,
  handle({ payload, id }) {
    console.log('receipt', payload.orderId, id);
  },
});
const queues = createQueues({
  queue: { default: 'default', connections: { default: { driver: 'memory' } } },
  jobs: [SendReceipt],
});
const accepted = await queues.connection().dispatch(SendReceipt, { orderId: 'order-1' });
const results = await queues.worker().drainOnce();
if (!accepted.accepted || results[0]?.outcome !== 'completed') throw new Error('Job failed');
```

`memory` and `sync` are development drivers and are not durable; production validation refuses
them as the default or as required connections. Configure an appropriate `database`,
`cloudflare-queues`, or `sqs` connection and supply its matching client/binding to `createQueues`.
Backends differ in delay, ordering, cancellation, deduplication and dead-letter capabilities;
inspect `queue.capabilities` rather than assuming one backend behaves like another.

## Wire an SQS connection

This is a composition-root example, not a complete deployment. Supply a real SQS client that
implements `SqsLike` (or adapt an SDK client with `sqsClientOf`) and a queue URL from your platform
environment. The verified snippet defines the wiring without contacting AWS.

```ts verify
import { createQueues, defineJob } from '@tsir/queue';
import type { SqsLike } from '@tsir/queue/sqs';

const ProcessOrder = defineJob<{ orderId: string }>({
  name: 'ProcessOrder',
  handle({ payload }) {
    console.log('process', payload.orderId);
  },
});

export function configureSqs(client: SqsLike, queueUrl: string) {
  return createQueues({
    queue: {
      default: 'orders',
      connections: { orders: { driver: 'sqs', queueUrl, outbox: true } },
    },
    bindings: { sqs: { orders: client } },
    jobs: [ProcessOrder],
    production: true,
  });
}
```

SQS standard queues do not guarantee order or broker-side deduplication; FIFO settings and delay
limits differ. `outbox: true` is a declaration, **not** an outbox implementation. Wire the actual
writer and relay below before publishing jobs as part of business transactions. The example also
needs an SQS consumer, IAM permissions, and a DLQ configured separately.

## Reliability and the outbox

Delivery is **at least once**, not exactly once. Make handlers idempotent against a durable business
key, even if a backend supports deduplication. `JobContext.id` is stable for retries of one dispatch,
but an outbox relay can dispatch again after a crash; do not rely on it alone across re-dispatches.
Do not put secrets or unnecessary personal data in payloads or dead letters. Monitor retries and
configure a DLQ/redrive policy for the broker; Tsir's dead-letter API requires its own configured
store for broker drivers.

Cloudflare Queues and SQS are non-transactional relative to your business database. Their
connections require `outbox: true`, and the deploy graph requires an exported events registry.
The flag alone does **not** record anything. Use `@tsir/events`' `createOutbox` and
`createPublisher`: call `publisher.record(event, payload, collectStatement)` to collect outbox SQL
into the **same atomic database batch/transaction** as the business write, then run
`publisher.relay()` after commit on a separately operated worker or schedule. Relay itself is
at-least-once. The [events reference](../packages/events.md) describes the event APIs; test a crash
between sending and marking published before relying on it.

## Write an order and outbox row atomically

The app must first apply the queue/outbox table migration (`tsir queue:table` prints the DDL),
declare a queued `OrderPlaced` listener, register its derived jobs with the queue, and construct a
`Publisher` from `createEvents`, `createOutbox({ sql: database })`, and that queue connection.
Then collect the publisher's SQL into the caller's batch, as below. This module is typechecked;
its function expects your configured database and publisher rather than opening a cloud connection.

```ts verify
import { statement, type Database, type DbStatement } from '@tsir/database';
import { defineEvent, type Publisher } from '@tsir/events';

export const OrderPlaced = defineEvent<{ orderId: string }>({ name: 'order.placed' });

export async function saveOrder(database: Database, publisher: Publisher, orderId: string) {
  const placeholder = database.capabilities.placeholder === 'dollar' ? '$1' : '?';
  const batch: DbStatement[] = [
    statement(`INSERT INTO orders (id) VALUES (${placeholder})`, [orderId]),
  ];
  await publisher.record(OrderPlaced, { orderId }, (sql, params) => {
    batch.push(statement(sql, params));
  });
  await database.batch(batch); // the business row and outbox rows commit together
  // A separately operated relay calls publisher.relay() after commit.
}
```

This assumes the `orders` and `queue_outbox` tables already exist on the **same** database and
that the configured listener is queued. `publisher.relay()` must be scheduled independently, with
monitoring and retries. Do not call direct `queue.dispatch` in place of the atomic recording step.

For a Bun process, operate a worker and drain it on shutdown; `tsir queue:work --connection default`
is available when the application exposes the expected queue registry. Cloudflare's native queue
trigger and Lambda SQS events require platform wiring and deployed consumers, not just `dispatch()`.
See [provider switching](./providers.md) and the [queue reference](../packages/queue.md).
