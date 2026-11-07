/**
 * Job queue.
 *
 * The queue and the event bus are co-located in `events.ts` because they
 * reference each other: queued listeners become jobs, and the queue's
 * registry must include those jobs. This module re-exports the queue so
 * callers can import `queue` and `queues` from a single, obvious place.
 */
export { queue, queues } from './events.ts';
