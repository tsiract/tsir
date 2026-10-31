/**
 * @tsir/events — typed events and the transactional outbox (`§ 4.5`).
 *
 * Public surface:
 *   defineEvent, defineListener, createEvents, createPublisher, createOutbox, deliveryJobName
 *
 * Two paths, and the difference between them is the whole package:
 *
 *   `events.dispatch(event, payload)`   sync listeners inline, queued listeners as jobs.
 *                                       Correct when a lost enqueue costs nothing.
 *
 *   `publisher.record(...)` + `relay()` the delivery is written **inside the caller's batch**,
 *                                       so the business row and its consequences commit or roll
 *                                       back together. Mandatory on a non-transactional broker.
 *
 * What this package deliberately does not do: guess whether a listener should be sync or queued
 * (it is declared), deliver an event whose name nobody declared (that is `CAP_UNKNOWN_EVENT`, not
 * an empty fan-out), or run a `sync` listener after the transaction it was supposed to be inside
 * has committed (`CAP_EVENTS_SYNC_OUTBOXED`).
 *
 * The outbox table itself is `queue_outbox` from `@tsir/queue`'s DDL (`tsir queue:table`), because
 * one migration should carry all three tables. The writer lives here: the queue knows what a
 * message is, this package knows what a delivery means.
 */

export { createEvents, deliveryMessage } from './bus.ts';
export type {
  CreateEventsOptions,
  DispatchContextOptions,
  DispatchReport,
  Events,
  EventsQueue,
} from './bus.ts';

export { defineEvent, defineListener, deliveryJobName, modeOf } from './event.ts';
export type {
  DeliveryEnvelope,
  EventContext,
  EventDefinition,
  EventMode,
  ListenerDefinition,
} from './event.ts';

export { createPublisher } from './publish.ts';
export type { BatchStatement, CreatePublisherOptions, Publisher } from './publish.ts';

export { createOutbox } from './outbox.ts';
export type { Outbox, OutboxEntry, OutboxOptions } from './outbox.ts';

export type { EventsErrorCode } from './errors.ts';
