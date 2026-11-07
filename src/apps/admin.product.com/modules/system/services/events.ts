/**
 * Event bus and job queue.
 *
 * `@tsir/events` dispatches events to listeners. Listeners can run inline
 * (`sync`) or as queue jobs (`queued`). The bus is bound to the default queue
 * connection so queued listeners are dispatched as jobs.
 *
 * Events are declared with `defineEvent` and listeners with `defineListener`.
 * Dispatch via `events.dispatch(event, payload)`.
 *
 * The queue and the event bus are co-built by `createEventsBootstrap`: a
 * queued listener becomes a job, and the queue's registry must include that
 * job before a dispatch can succeed.
 */
import { createEventsBootstrap } from '@tsir/events';
import { databases } from '../../../database.ts';
import appConfig from '../../../config/queue.ts';
import { logger } from './pulse.ts';
import { SendWelcomeEmailJob } from '../queues/send-welcome-email.job.ts';
import { UserRegisteredEvent } from '../events/user-registered.event.ts';
import { SendWelcomeEmailListener } from '../listeners/send-welcome-email.listener.ts';

const {
  events,
  eventsToken,
  eventsProvider,
  queues,
  queue,
  queuesToken,
  queueToken,
  queuesProvider,
  queueProvider,
} = createEventsBootstrap({
  listeners: [SendWelcomeEmailListener],
  queue: appConfig,
  queueBindings: {
    databases: { primary: databases.defaultDatabase },
  },
  jobs: [SendWelcomeEmailJob],
  log: (message) => logger.info(message),
});

export { events, eventsToken, eventsProvider };
export { queues, queue, queuesToken, queueToken, queuesProvider, queueProvider };

/** Re-export the event so callers don't have to import from the events dir. */
export { UserRegisteredEvent };
