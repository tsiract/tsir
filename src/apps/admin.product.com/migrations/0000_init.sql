-- Admin app initial schema (D1 / SQLite).
--
-- One migration creates every table: users, the RBAC tables (roles,
-- permissions, groups and their join tables), sessions, password-reset tokens,
-- the install-state marker, i18n keys/translations, and email templates.
--
-- D1 speaks SQLite: UUIDs are TEXT, timestamps are ISO-8601 TEXT, JSON is TEXT,
-- booleans are INTEGER (0/1). Foreign keys are `ON DELETE CASCADE` where
-- removing the parent must remove the assignment; `RESTRICT` where the parent
-- deletion should be blocked by dependents.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  is_super_admin  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
--> statement-breakpoint

CREATE TABLE roles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
--> statement-breakpoint

CREATE TABLE permissions (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  created_at   TEXT NOT NULL
);
--> statement-breakpoint

CREATE TABLE groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
--> statement-breakpoint

-- Role has many permissions.
CREATE TABLE role_permissions (
  role_id        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
--> statement-breakpoint

-- User has many roles.
CREATE TABLE user_roles (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
--> statement-breakpoint

-- User has custom permissions (overrides/additions beyond roles).
CREATE TABLE user_permissions (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id  TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_id)
);
--> statement-breakpoint

-- Group has many users.
CREATE TABLE group_users (
  group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
--> statement-breakpoint

-- Group has many roles.
CREATE TABLE group_roles (
  group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, role_id)
);
--> statement-breakpoint

-- Group has custom permissions.
CREATE TABLE group_permissions (
  group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  permission_id  TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, permission_id)
);
--> statement-breakpoint

-- Sessions: @tsir/auth compatible shape (sessionTableDdl).
-- `id` is sha256(token); `subject` is the user id; `data` carries the principal
-- payload as JSON. Everything is hashed/integral at rest.
CREATE TABLE tsir_sessions (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  data          TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  user_agent    TEXT,
  ip            TEXT
);
--> statement-breakpoint
CREATE INDEX tsir_sessions_subject_idx ON tsir_sessions(subject);
--> statement-breakpoint
CREATE INDEX tsir_sessions_expiry_idx ON tsir_sessions(expires_at);
--> statement-breakpoint

-- Password-reset tokens (SHA-256 hashed at rest).
CREATE TABLE password_reset_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT,
  created_at    TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens(user_id);
--> statement-breakpoint

-- Install state: a single row marks first-run as complete.
CREATE TABLE install_state (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  installed_at  TEXT NOT NULL,
  admin_email   TEXT NOT NULL
);
--> statement-breakpoint

-- i18n: keys are stable, translations are per-locale overrides.
CREATE TABLE i18n_keys (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  namespace   TEXT NOT NULL DEFAULT 'common',
  created_at  TEXT NOT NULL
);
--> statement-breakpoint

CREATE TABLE i18n_translations (
  id          TEXT PRIMARY KEY,
  key_id      TEXT NOT NULL REFERENCES i18n_keys(id) ON DELETE CASCADE,
  locale      TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (key_id, locale)
);
--> statement-breakpoint

-- Email templates: name is unique, subject/html/text are editable.
CREATE TABLE email_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  subject     TEXT NOT NULL,
  html        TEXT,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
--> statement-breakpoint

-- Audit log for admin actions.
CREATE TABLE audit_logs (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  subject      TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_id);
--> statement-breakpoint
CREATE INDEX audit_logs_action_idx ON audit_logs(action);
