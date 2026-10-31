# Tasks — `@tsir/schedule` (Phase 7)

> Cron tasks and the distributed lock that keeps two ticks from overlapping. The package owns the
> **cron**, the **task declaration**, the **tick** and the **lock** — four small things that must
> agree, because the failure they prevent is invisible: a task that runs twice, or on the wrong day,
> or not at all, looks exactly like a task that ran.
>
> **Plan:** [`15-capabilities.md § 4.6`](../modules/15-capabilities.md) · **Deploy:** `08-deploy.md § 1`
> (schedule units, cron triggers) · **Related:** [`queue.md`](./queue.md) (`CAP-004`, the same
> per-connection trigger rule for the other background work).

**Status: complete.** Fourteen tasks, six source modules, four test files, four console commands;
`tsir schedule:*` reads the app's own `tasks` export, and `deploy:plan` turns them into cron
triggers — shifted to UTC where the platform requires it, refused where it cannot be.

## Tasks

| ID         | Task                                                                        | Status | Depends               | Acceptance                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------- | ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHED-1`  | `parseCron` — five fields, macros, steps, ranges; canonical form            | `[x]`  | —                     | `@daily` is `0 0 * * *`; a six-field cron is refused with the reason; the origin is named in the error                                                   |
| `SCHED-2`  | Both day fields restricted is a declaration error                           | `[x]`  | `SCHED-1`             | `0 0 1 * 1` is refused: crontab means OR, EventBridge keeps one — the message names the two-task fix                                                     |
| `SCHED-3`  | `matchesCron` / `nextRunAt` / `nextRuns` in UTC plus a fixed offset         | `[x]`  | `SCHED-1`             | Truncates to the minute; a cron the calendar cannot satisfy (`0 0 30 2 *`) returns `undefined` within a five-year bound                                  |
| `SCHED-4`  | `toUtcCron` — a declared local hour as the expression the platform fires    | `[x]`  | `SCHED-3`             | A whole-hour shift is applied (`0 3 * * *` at +480 → `0 19 * * *`); a day rule that would move is refused, not approximated                              |
| `SCHED-5`  | `defineTask` — name, cron, handler, and three opinions                      | `[x]`  | `SCHED-1`             | Defaults are `overlap: 'skip'`, `timeoutMs: 300_000`, offset `0`; a bad name/offset/timeout fails at declaration                                         |
| `SCHED-6`  | `createTaskRegistry` — the name is the lock key                             | `[x]`  | `SCHED-5`             | Two tasks named `nightly` are refused, because they would share one lock and skip each other silently                                                    |
| `SCHED-7`  | Lock port — `acquire` / `release` / `inspect` / `list`, `shared` capability | `[x]`  | —                     | `acquire` is atomic; an expired lock is free; `release` is owner-checked and returns `false` for a lock this owner lost                                  |
| `SCHED-8`  | `memoryLock` — one process, and it says so                                  | `[x]`  | `SCHED-7`             | `shared: false`; expiry is read-time, so a crashed holder stops blocking without a sweep                                                                 |
| `SCHED-9`  | `databaseLock` — d1 and postgres, one statement                             | `[x]`  | `SCHED-7`             | The take is a single conditional upsert + `RETURNING`; MySQL is refused (`CAP_LOCK_REFUSED`) because `ON DUPLICATE KEY` has no `WHERE`                   |
| `SCHED-10` | `scheduleLockDdl` — the table and the expiry index                          | `[x]`  | `SCHED-9`             | `tsir schedule:table` prints exactly the columns the driver queries, per engine                                                                          |
| `SCHED-11` | `lockConformance` — the kit every future lock driver must pass              | `[x]`  | `SCHED-7`             | Racing acquisitions yield one winner; TTL expiry; owner-checked release; `singleProcess` marks the cases a memory lock cannot pass                       |
| `SCHED-12` | `createScheduler` — the tick, four outcomes, and no swallowed failures      | `[x]`  | `SCHED-6`, `SCHED-11` | `run` / `runDue` / `scheduled`; `scheduledFor` is the cron's time; a failure never stops the next task and reaches `onError` as a coded error            |
| `SCHED-13` | `production: true` refuses a per-process lock                               | `[x]`  | `SCHED-12`            | `SCHED_LOCK_NOT_SHARED` names the tasks that rely on it; an `overlap: 'allow'`-only project passes                                                       |
| `SCHED-14` | `tsir schedule:list\|run\|work\|table`, and schedules in the deploy graph   | `[x]`  | `SCHED-12`, deploy    | The entry's `tasks` are the deploy's cron triggers; `--once` exits non-zero on a failed task; `DPL_CRON_NOT_UTC` for a local hour a platform cannot fire |

## As built: the tick

```
runDue(at) ─▶ due tasks ─▶ acquire lock ─▶ handle() ─▶ release ─▶ outcome
                                 │
                                 └── held ─▶ `busy` (not a failure)
```

One fact drives all of it: **a cron has no retry.** There is no dead-letter store behind a
scheduled task and no backoff between ticks — the next tick _is_ the retry. So the scheduler
reports every outcome instead of swallowing one, releases the lock on failure and timeout so the
next tick can try, and keeps the lock TTL (`timeoutMs + 60 s`) as the bound for the run that never
returned at all.

`busy` is reported separately from `failed` because they are different pages in an on-call
rotation: "skipped, the last run is still going" is the lock doing its job, and a pipeline that
treats it as a failure retries a run that is already happening (`schedule:run` exits 0 for it).

Duplicated ticks are possible and are not hidden: a platform that retries an invocation, or two
isolates racing a lock that expired between them, can run one task twice for one tick. The lock
prevents **overlap**, not duplication, and `context.scheduledFor` is the key that makes a handler
idempotent.

## As built: the lock is its own port

`plans/modules/15-capabilities.md § 6` said the lock would reuse `@tsir/cache`. It cannot: a lock needs a
**conditional write** — "take this only if it is free" — and the cache port has an atomic
`increment` but an unconditional `set` and no compare-and-set. A cache-backed lock would be a
read-then-write race dressed up as mutual exclusion, and widening five cache drivers to serve one
caller is the wrong trade for the framework. So the lock is a port of its own, and § 4.6 records
the amendment in the change that made it (rule 5 of [`README.md`](./README.md)).

The database driver takes the lock in **one statement**, because two statements are two chances to
lose a race:

```sql
INSERT INTO schedule_locks (name, owner, expires_at) VALUES (?, ?, ?)
ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
WHERE expires_at <= ?          -- the condition is the lock
RETURNING name, owner, expires_at
```

MySQL is refused rather than approximated: `ON DUPLICATE KEY UPDATE` has no `WHERE`, so the take
would need a read first, and that read is the race.

## As built: one declaration, two readers

```
app entry ──export const tasks = [Hourly, …]──┬─▶ tsir schedule:list|run|work   (the runtime)
                                              └─▶ deploymentOf() → cron triggers (the build)
```

`tsir.js` has no `schedules` key on purpose. A cron that exists in two files is a cron that
disagrees with itself, and the one the deployer reads is never the one the worker runs. The graph
carries the **platform's** expression (`toUtcCron`) while `deploy:plan --explain` prints the
declared one beside it, so a shift is visible in review.

The one line an app writes for a deployed schedule is the handler:

```ts
export const scheduled = (controller: ScheduledController) =>
  scheduler.scheduled({ at: controller.scheduledTime });
```

Generated entries cannot do that without also owning the `env` → lock plumbing, which is
`08-deploy.md`'s decision, not a shortcut to take here.

## What the gates check

`bun test src/framework/schedule` (59 tests) covers the cron engine, both lock drivers against the
conformance kit, and the scheduler; `schedule.test.ts` in the console (24 tests) runs every command
as a **subprocess**, because two `schedule:run` processes agreeing about one lock is the property
an in-process test cannot see. `make coverage` includes the package against the same floor as the
rest of `src/framework`.
