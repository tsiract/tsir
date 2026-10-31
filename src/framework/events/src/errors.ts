/**
 * Event errors (`§ 4.5`, `§ 8`).
 *
 * The one that carries the design opinion is `CAP_EVENTS_SYNC_OUTBOXED`: a `sync` listener on an
 * event published through the outbox cannot work, and it cannot fail loudly at run time either —
 * by the time the relay runs, the caller's transaction is over and the "inline" handler has
 * nothing to be inline *with*. So it is refused when the publisher is built, naming the listener,
 * because a rule that is only in a doc is a rule someone will break on a Friday.
 *
 * Every message names the event, and the listener where there is one: `OrderPlaced` alone does
 * not say which of its four listeners failed, and "an event handler threw" is not an address.
 */

import { TsirError } from '@tsir/container';

export type EventsErrorCode =
  | 'CAP_UNKNOWN_EVENT'
  | 'CAP_EVENT_FAILED'
  | 'CAP_EVENTS_NO_QUEUE'
  | 'CAP_EVENTS_SYNC_OUTBOXED'
  | 'CAP_OUTBOX_WRITE_FAILED';

const KIND = 'capability';

export function unknownEvent(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'CAP_UNKNOWN_EVENT',
    `unknown event "${name}" (declared: ${known.length === 0 ? 'none' : known.join(', ')})`,
    {
      kind: KIND,
      hint: 'declare it with `defineEvent` and pass its listeners to `createEvents` — an undeclared event never dispatches silently',
      context: { event: name },
    },
  );
}

export function eventFailed(
  event: string,
  failures: readonly { readonly listener: string; readonly detail: string }[],
): TsirError {
  const first = failures[0];
  return new TsirError(
    'CAP_EVENT_FAILED',
    `event "${event}" failed in ${String(failures.length)} listener(s): ` +
      failures.map((failure) => `${failure.listener} (${failure.detail})`).join('; '),
    {
      kind: KIND,
      // A sync listener runs inside the caller's flow: if the caller is writing, this throw is
      // the only thing standing between a half-applied fan-out and a rollback.
      hint: `a \`sync\` listener throws to its caller — make ${
        first?.listener ?? 'the listener'
      } \`queued\` if it can fail without the caller knowing`,
      context: { event, failed: String(failures.length) },
    },
  );
}

export function noQueueForListener(event: string, listener: string): TsirError {
  return new TsirError(
    'CAP_EVENTS_NO_QUEUE',
    `listener "${listener}" of event "${event}" is \`queued\`, but no queue is bound`,
    {
      kind: KIND,
      hint: 'pass `queue: queues.connection()` to `createEvents`, or make the listener `sync`',
      context: { event, listener },
    },
  );
}

export function syncListenerOutboxed(event: string, listener: string): TsirError {
  return new TsirError(
    'CAP_EVENTS_SYNC_OUTBOXED',
    `listener "${listener}" of event "${event}" is \`sync\`, but the event is published through the outbox`,
    {
      kind: KIND,
      hint: 'the outbox publishes after the transaction commits, so every listener on it must be `queued` — or call `events.dispatch` and skip the outbox',
      context: { event, listener },
    },
  );
}

export function outboxWriteFailed(event: string, detail: string): TsirError {
  return new TsirError(
    'CAP_OUTBOX_WRITE_FAILED',
    `could not record event "${event}" in the outbox: ${detail}`,
    {
      kind: KIND,
      hint: 'the row joins your `batch()` — a failure here means the business write would have committed without its deliveries',
      context: { event },
    },
  );
}
