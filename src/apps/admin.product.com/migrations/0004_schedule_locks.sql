-- Scheduled-task locks.
--
-- One row per task, reused forever: an expired row is overwritten by the next acquire, so the
-- table stays the size of the schedule. The `database` lock's acquire is a single upsert with a
-- `WHERE` on the existing row, which is why this table needs a primary key rather than a flag.
--
-- The DDL mirrors `scheduleLockDdl({ engine: 'sqlite' })` from `@tsir/schedule`.

CREATE TABLE IF NOT EXISTS schedule_locks (
  name        TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
--> statement-breakpoint

-- The acquire's `WHERE expires_at <= ?` reads this; without it a growing table makes every tick a
-- scan.
CREATE INDEX IF NOT EXISTS schedule_locks_expiry ON schedule_locks (expires_at);
