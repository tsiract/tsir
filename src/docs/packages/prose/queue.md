## Example

Define a job, register it, and dispatch it to a connection. The memory driver keeps jobs in the
process, which is right for tests and for a single local run. A durable driver is set on the
connection in production.

```ts
import { createJobRegistry, createQueue, defineJob } from '@tsir/queue';
import { memoryQueueDriver } from '@tsir/queue/memory';

const SendReceipt = defineJob<{ orderId: string }>({
  name: 'SendReceipt',
  maxAttempts: 3,
  backoff: { baseMs: 100, factor: 2, maxMs: 10_000, jitter: 0 },
  timeoutMs: 1_000,
  handle({ payload }) {
    console.log('receipt for', payload.orderId);
  },
});

const registry = createJobRegistry([SendReceipt]);
const backend = memoryQueueDriver().open();
const queue = createQueue({
  connection: 'default',
  backend,
  jobs: registry,
  connections: ['default'],
});

const result = await queue.dispatch({ name: 'SendReceipt' }, { orderId: 'o-1' });
console.log(result.accepted);
```

## Failure modes

- `CAP_UNKNOWN_CONNECTION`: a connection name was used that is not declared. Dispatch never falls back
  to the default queue.
- `CAP_UNKNOWN_JOB`: a job name was dispatched that is not registered. The message lists the
  registered jobs.
- `CAP_DISPATCH_FAILED`: the broker did not accept the message. Retrying the dispatch is safe.
  Dispatching something else in its place may not be.
- `CAP_JOB_TIMEOUT`: a job ran past its `timeoutMs` on one attempt. A timeout is retried like any
  other failure.
- `CAP_OUTBOX_REQUIRED`: the connection's driver cannot enqueue inside the caller's own database
  write. The application must write the job to the outbox in the same transaction as the business
  row. Without that, the two can diverge.
- `CAP_DRIVER_MISSING`: the connection names a driver this build does not ship, or a client it needs
  was not supplied.
- `CAP_FORBIDDEN_IN_PRODUCTION`: a connection uses an ephemeral driver in production.
- `CAP_UNSUPPORTED_OPERATION`: the connection's driver cannot do what was asked, such as a delayed
  message on a driver that has no delay.

Failed jobs that exhaust their attempts move to the dead-letter store, where they can be listed,
retried or discarded.

## Security notes

A job is delivered at least once. The idempotency key on a dispatch makes a second dispatch with the
same key a no-op, so a handler should also be safe to run twice. Payloads are stored as the broker
received them, and the dead-letter store keeps them after a failure, so put identifiers in payloads
and not personal data or secrets. Jobs are registered in code, and a message that names an
unregistered job is dead-lettered rather than run.
