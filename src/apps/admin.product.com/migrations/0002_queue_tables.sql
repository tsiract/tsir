-- Horizon-style queue tables.
--
-- Three tables back the `database` queue driver:
--   · queue_jobs    — pending, leased (running), and delayed jobs
--   · queue_dead    — dead letters (failed, exhausted retries)
--   · queue_outbox  — transactional outbox for event-driven dispatch
--
-- The DDL mirrors `@tsir/queue`'s `queueTableDdl({ engine: 'sqlite' })`.

CREATE TABLE IF NOT EXISTS queue_jobs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  connection       TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  available_at     INTEGER NOT NULL,
  leased_until     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_error       TEXT,
  idempotency_key  TEXT,
  request_id       TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS queue_jobs_due ON queue_jobs (available_at, leased_until);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_idempotency ON queue_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS queue_dead (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  connection       TEXT NOT NULL,
  attempts         INTEGER NOT NULL,
  max_attempts     INTEGER NOT NULL,
  available_at     INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  last_error       TEXT,
  idempotency_key  TEXT,
  request_id       TEXT
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS queue_outbox (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  connection       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  idempotency_key  TEXT,
  request_id       TEXT,
  published_at     INTEGER
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS queue_outbox_unpublished ON queue_outbox (published_at);
