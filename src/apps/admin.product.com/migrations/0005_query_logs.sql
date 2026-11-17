-- Query monitoring (`DX-014`).
--
-- One row per statement a connection reported. The DDL mirrors `telemetryTableDdl('d1')` from
-- @tsir/telemetry — that function stays authoritative, and this file is what a migration runner
-- actually applies.
--
-- `sql` holds the *redacted* statement. The writer redacts before it inserts (`DX-016`), so a value
-- cannot reach this table even for a statement a caller wrote by hand.

CREATE TABLE IF NOT EXISTS query_logs (
  id          TEXT PRIMARY KEY,
  connection  TEXT NOT NULL,
  sql         TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  rows        INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
--> statement-breakpoint

-- The monitor's first question is "what was slow", and its default window is recent.
CREATE INDEX IF NOT EXISTS query_logs_created ON query_logs (created_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS query_logs_duration ON query_logs (duration_ms);
