/**
 * The shared Drizzle schema for the admin app.
 *
 * Every module imports its tables from here — a single source of truth for the
 * shape the migration created. Drizzle's `sqliteTable` keeps the column types in
 * lockstep with the SQL, so a rename here is a compile error at every call site
 * rather than a runtime "column does not exist".
 *
 * D1 (SQLite) has no native UUID, timestamp, JSON, or boolean types — they are
 * stored as TEXT/INTEGER and the application owns the serialization. UUIDs are
 * `crypto.randomUUID()` strings; timestamps are ISO-8601; booleans are 0/1.
 */
import { randomUUID } from 'node:crypto';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const nowIso = () => new Date().toISOString();

/* ── identity ─────────────────────────────────────────────────────────────── */

export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  isSuperAdmin: integer('is_super_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
});

/* ── rbac ─────────────────────────────────────────────────────────────────── */

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
});

export const permissions = sqliteTable('permissions', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
});

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
});

export const rolePermissions = sqliteTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionId] }) }),
);

export const userRoles = sqliteTable(
  'user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.roleId] }) }),
);

export const userPermissions = sqliteTable(
  'user_permissions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.permissionId] }) }),
);

export const groupUsers = sqliteTable(
  'group_users',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.userId] }) }),
);

export const groupRoles = sqliteTable(
  'group_roles',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.roleId] }) }),
);

export const groupPermissions = sqliteTable(
  'group_permissions',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.permissionId] }) }),
);

/* ── auth side tables ─────────────────────────────────────────────────────── */

export const sessions = sqliteTable(
  'tsir_sessions',
  {
    id: text('id').primaryKey(),
    subject: text('subject').notNull(),
    data: text('data'),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => ({
    subjectIdx: index('tsir_sessions_subject_idx').on(t.subject),
    expiryIdx: index('tsir_sessions_expiry_idx').on(t.expiresAt),
  }),
);

export const passwordResetTokens = sqliteTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey().$defaultFn(randomUUID),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ userIdx: index('password_reset_tokens_user_idx').on(t.userId) }),
);

/* ── install state ────────────────────────────────────────────────────────── */

export const installState = sqliteTable('install_state', {
  id: integer('id').primaryKey().default(1),
  installedAt: text('installed_at').notNull().$defaultFn(nowIso),
  adminEmail: text('admin_email').notNull(),
});

/* ── i18n ─────────────────────────────────────────────────────────────────── */

export const i18nKeys = sqliteTable('i18n_keys', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  key: text('key').notNull().unique(),
  namespace: text('namespace').notNull().default('common'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
});

export const i18nTranslations = sqliteTable(
  'i18n_translations',
  {
    id: text('id').primaryKey().$defaultFn(randomUUID),
    keyId: text('key_id')
      .notNull()
      .references(() => i18nKeys.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    value: text('value').notNull(),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ uniq: primaryKey({ columns: [t.keyId, t.locale] }) }),
);

/* ── mail ─────────────────────────────────────────────────────────────────── */

export const emailTemplates = sqliteTable('email_templates', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  name: text('name').notNull().unique(),
  subject: text('subject').notNull(),
  html: text('html'),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
});

/* ── audit ────────────────────────────────────────────────────────────────── */

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey().$defaultFn(randomUUID),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    subject: text('subject'),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    actorIdx: index('audit_logs_actor_idx').on(t.actorId),
    actionIdx: index('audit_logs_action_idx').on(t.action),
  }),
);

export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type Group = typeof groups.$inferSelect;

/* ── telemetry: owned by @tsir/telemetry (Telescope + Horizon-style) ───────── */

export { requestLogs, queueJobs, queueDead } from '@tsir/telemetry';

import type {
  requestLogs as _requestLogs,
  queueJobs as _queueJobs,
  queueDead as _queueDead,
} from '@tsir/telemetry';

export type RequestLog = typeof _requestLogs.$inferSelect;
export type QueueJob = typeof _queueJobs.$inferSelect;
export type QueueDeadJob = typeof _queueDead.$inferSelect;
