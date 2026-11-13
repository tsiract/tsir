/**
 * Scheduled tasks.
 *
 * `@tsir/schedule` runs cron-like tasks. Each task has a cron expression, a
 * timeout, and an overlap policy (`skip` prevents two instances running at
 * once across instances). The lock provider comes from `config/schedule.ts`:
 * `memoryLock` on a laptop, `databaseLock` wherever more than one instance can
 * run a tick.
 *
 * The scheduler is exposed for the `scheduled` trigger (Cron Triggers on
 * Workers) and for `tsir schedule:run`. Call `scheduler.runDue(at)` to run
 * everything due at a given time.
 */
import { createScheduleBootstrap, defineTask, lockFromConfig } from '@tsir/schedule';
import { isProduction } from '@tsir/core';
import { TsirError } from '@tsir/container';

import { databases } from '../../../database.ts';
import scheduleConfig from '../../../config/schedule.ts';
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

// `memoryLock` here would mean two instances each hold their own `Map`, both see the lock as free,
// and both run the task. `tsir.js` names the provider now, so production is a config decision
// rather than a constant in this file.
const lock = lockFromConfig({
  lock: scheduleConfig.lock,
  sql: databases.defaultDatabase,
  production: isProduction(),
});

if (lock === undefined) {
  throw new TsirError(
    'SCHED_LOCK_REFUSED',
    'this app requires `schedule.lock` in `tsir.js`, and the project has none',
    {
      kind: 'capability',
      hint: "add `config/schedule.ts` with `lock: { driver: 'database' }`",
      context: {},
    },
  );
}

export const { scheduler, schedulerToken, schedulerProvider } = createScheduleBootstrap({
  tasks: [cleanupTask],
  lock,
  log: (message) => logger.info(message),
});
