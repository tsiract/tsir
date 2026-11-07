/**
 * Scheduled tasks.
 *
 * `@tsir/schedule` runs cron-like tasks. Each task has a cron expression, a
 * timeout, and an overlap policy (`skip` prevents two instances running at
 * once across instances). A lock provider serialises runs — `memoryLock` for
 * dev, `databaseLock` for production.
 *
 * The scheduler is exposed for the `scheduled` trigger (Cron Triggers on
 * Workers) and for `tsir schedule:run`. Call `scheduler.runDue(at)` to run
 * everything due at a given time.
 */
import { createScheduleBootstrap, defineTask, memoryLock } from '@tsir/schedule';
import { logger } from './pulse.ts';

const cleanupTask = defineTask({
  name: 'cleanup.stale-sessions',
  cron: '0 3 * * *',
  timeoutMs: 60_000,
  overlap: 'skip',
  description: 'Clear stale sessions and expired cache entries',
  handle(context) {
    context.log(`cleanup.stale-sessions run ${context.scheduledFor}`);
  },
});

export const { scheduler, schedulerToken, schedulerProvider } = createScheduleBootstrap({
  tasks: [cleanupTask],
  lock: memoryLock(),
  log: (message) => logger.info(message),
});
