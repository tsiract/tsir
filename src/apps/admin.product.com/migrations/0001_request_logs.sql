-- Telescope-style request log.
--
-- One row per HTTP request the admin app handled. We deliberately do NOT store
-- request or response bodies, nor any headers that can carry secrets
-- (authorization, cookie, set-cookie). The `principal_subject` column holds the
-- authenticated user id (or NULL for anonymous requests) so the audit trail can
-- be filtered by actor.

CREATE TABLE request_logs (
  id                TEXT PRIMARY KEY,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  status            INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  principal_subject TEXT,
  ip                TEXT,
  user_agent        TEXT,
  created_at        INTEGER NOT NULL
);
--> statement-breakpoint

CREATE INDEX idx_request_logs_created_at ON request_logs(created_at DESC);
--> statement-breakpoint
CREATE INDEX idx_request_logs_status ON request_logs(status);
--> statement-breakpoint
CREATE INDEX idx_request_logs_method ON request_logs(method);
