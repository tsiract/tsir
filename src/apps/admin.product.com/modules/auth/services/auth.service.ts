/**
 * Authentication service: password hashing, sessions, login, logout.
 *
 * Wraps `@tsir/auth` so the rest of the app never reaches past this file. The
 * session store is the database one (`tsir_sessions` table); the hasher is the
 * default PBKDF2-SHA256.
 *
 * `sessions` and `guard` are built eagerly here because the `db` provider uses
 * a deferred D1 driver — the actual connection is not opened until the first
 * query, so constructing these at boot is safe.
 */
import {
  createSessions,
  databaseSessionStore,
  sessionGuard,
  type PasswordHasher,
  type Principal,
  type Sessions,
} from '@tsir/auth';
import type { Guard } from '@tsir/auth';
import { token } from '@tsir/container';
import type { Database } from '@tsir/database';

import { users } from '../../shared/schema.ts';
import { eq } from 'drizzle-orm';

const sessionConfig = (await import('../../../config/_session.ts')).default;

export interface AuthPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly isSuperAdmin: boolean;
}

export type AppPrincipal = Principal<AuthPrincipal>;

/** Build a sessions store backed by the database. */
export function createSessionsFromDb(db: Database): Sessions {
  return createSessions({
    store: databaseSessionStore(db, { table: 'tsir_sessions' }),
    ttlMs: sessionConfig.absoluteMs,
    idleTtlMs: sessionConfig.idleMs,
  });
}

/** Build the session guard from a sessions instance. */
export function createGuardFromSessions(sessions: Sessions): Guard<AuthPrincipal> {
  return sessionGuard({
    sessions,
    principal: (session) => ({
      subject: session.subject,
      data: session.data as AuthPrincipal,
    }),
  });
}

/**
 * Super-admin authorization guard.
 *
 * Runs *after* the `session` guard (which sets `ctx.principal`). Returns the
 * principal unchanged when `data.isSuperAdmin` is true; otherwise returns
 * `null`, which the pipeline turns into a 401. The server is the source of
 * truth — frontend state can never elevate a user.
 */
export function createSuperAdminGuard(): Guard<AuthPrincipal> {
  return async (context) => {
    const principal = (context as { principal?: Principal<AuthPrincipal> }).principal;
    if (principal === undefined) return null;
    if (!principal.data.isSuperAdmin) return null;
    return principal;
  };
}

export const hasherToken = token<PasswordHasher>('hasher');
export const sessionsToken = token<Sessions>('sessions');
export const guardToken = token<Guard<AuthPrincipal>>('guard');
export const authServiceToken = token<AuthService>('AuthService');

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly sessions: Sessions,
    private readonly guard: Guard<AuthPrincipal>,
  ) {}

  /** Verify credentials and start a session. Returns the session cookie, or null. */
  async login(email: string, password: string): Promise<string | null> {
    const row = await this.db.query({
      sql: 'SELECT id, email, password_hash, is_super_admin FROM users WHERE email = ?',
      params: [email.toLowerCase()],
      format: 'objects',
    } as never);
    const user = row.rows[0] as
      { id: string; email: string; password_hash: string; is_super_admin: number } | undefined;
    if (user === undefined) return null;

    const ok = await this.hasher.verify(password, user.password_hash);
    if (!ok) return null;

    const principal: AuthPrincipal = {
      userId: user.id,
      email: user.email,
      isSuperAdmin: user.is_super_admin === 1,
    };
    const { cookie } = await this.sessions.start({ subject: user.id, data: principal });
    return cookie;
  }

  /** End a session by its token (logout). */
  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  /** Read the principal from a request's session cookie. */
  async readPrincipal(request: Request): Promise<AppPrincipal | null> {
    return this.guard({ request });
  }

  /** Hash a password for storage. */
  hashPassword(password: string): Promise<string> {
    return this.hasher.hash(password);
  }

  /** Find a user by email. */
  async findUserByEmail(
    email: string,
  ): Promise<
    { id: string; email: string; display_name: string | null; is_super_admin: number } | undefined
  > {
    const result = await this.db.query({
      sql: 'SELECT id, email, display_name, is_super_admin FROM users WHERE email = ?',
      params: [email.toLowerCase()],
      format: 'objects',
    } as never);
    return result.rows[0] as
      | { id: string; email: string; display_name: string | null; is_super_admin: number }
      | undefined;
  }

  /** Find a user by id. */
  async findUserById(
    id: string,
  ): Promise<
    { id: string; email: string; display_name: string | null; is_super_admin: number } | undefined
  > {
    const result = await this.db.query({
      sql: 'SELECT id, email, display_name, is_super_admin FROM users WHERE id = ?',
      params: [id],
      format: 'objects',
    } as never);
    return result.rows[0] as
      | { id: string; email: string; display_name: string | null; is_super_admin: number }
      | undefined;
  }

  /** Expose sessions for the controller (cookie name, tokenOf). */
  getSessions(): Sessions {
    return this.sessions;
  }
}

/** The `users` table import keeps Drizzle's schema in the module graph. */
void eq;
void users;
