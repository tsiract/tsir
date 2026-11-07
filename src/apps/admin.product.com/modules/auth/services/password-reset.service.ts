/**
 * Password-reset tokens.
 *
 * A reset token is a random value, SHA-256 hashed before storage, with a 1-hour
 * expiry. The plaintext token is returned once (to email to the user); the row
 * holds only the hash. Consuming a token marks it `consumed_at` so it cannot be
 * reused.
 */
import type { Database } from '@tsir/database';
import { and, eq, isNull } from 'drizzle-orm';
import { hashToken, randomToken } from '@tsir/auth';
import { token } from '@tsir/container';
import type { DrizzleDb } from '../../../database.ts';

import { passwordResetTokens, users } from '../../shared/schema.ts';

const TTL_MS = 1000 * 60 * 60; // 1 hour

export interface ResetToken {
  readonly token: string;
  readonly userId: string;
  readonly email: string;
}

export const passwordResetServiceToken = token<PasswordResetService>('PasswordResetService');

export class PasswordResetService {
  constructor(
    private readonly db: Database,
    private readonly drizzle: DrizzleDb,
  ) {}

  /** Issue a reset token for a user. Returns the plaintext token (email it once). */
  async issueResetToken(email: string): Promise<ResetToken | null> {
    const row = await this.drizzle.select().from(users).where(eq(users.email, email.toLowerCase()));
    const user = row[0];
    if (user === undefined) return null;

    const token = randomToken(32);
    const hash = await hashToken(token);
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

    await this.drizzle.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hash,
      expiresAt,
    });

    return { token, userId: user.id, email: user.email };
  }

  /** Consume a reset token and set the new password. Returns false if invalid/expired. */
  async consumeResetToken(token: string, newPasswordHash: string): Promise<boolean> {
    const hash = await hashToken(token);
    const row = await this.drizzle
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.tokenHash, hash), isNull(passwordResetTokens.consumedAt)));
    const record = row[0];
    if (record === undefined) return false;
    if (new Date(record.expiresAt).getTime() < Date.now()) return false;

    await this.db.query({
      sql: "UPDATE password_reset_tokens SET consumed_at = datetime('now') WHERE id = ?",
      params: [record.id],
      format: 'objects',
    } as never);
    await this.drizzle
      .update(users)
      .set({ passwordHash: newPasswordHash })
      .where(eq(users.id, record.userId));
    return true;
  }

  /** Check whether a token is still valid (for the "enter new password" screen). */
  async isValidResetToken(token: string): Promise<boolean> {
    const hash = await hashToken(token);
    const row = await this.drizzle
      .select({ id: passwordResetTokens.id, expiresAt: passwordResetTokens.expiresAt })
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.tokenHash, hash), isNull(passwordResetTokens.consumedAt)));
    const record = row[0];
    if (record === undefined) return false;
    return new Date(record.expiresAt).getTime() >= Date.now();
  }
}
