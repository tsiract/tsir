// config/schedule.ts — how scheduled tasks serialise.
//
// A scheduler on two instances must run each task once. `memoryLock` is a `Map` per process, so
// both instances see the lock as free and both run the job — and the failure is a job that ran
// twice, which nothing reports. `databaseLock` records the holder in `schedule_locks`, so the
// guarantee survives the process that took it.
//
// `tsir migrate` creates the table (`tsir_schedule:table` on an existing project). `memory` is
// refused once `APP_ENV=production`; this app is deployed, so the answer is `database`.
export default {
  lock: {
    driver: 'database',
    table: 'schedule_locks',
  },
};
