/**
 * The audit log service.
 *
 * Every admin action that changes state writes a row here. The actor is the
 * authenticated user's id (or `null` for system actions like install). The
 * action is a dotted name (`users.create`, `roles.assign`, …) so a consumer can
 * filter by prefix.
 */
import { token } from '@tsir/container';
import { type DrizzleDb } from '../../database.ts';
import { auditLogs } from './schema.ts';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  subject?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export const auditServiceToken = token<AuditService>('AuditService');

export class AuditService {
  constructor(private readonly drizzle: DrizzleDb) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.drizzle.insert(auditLogs).values({
      actorId: entry.actorId,
      action: entry.action,
      subject: entry.subject,
      metadata: JSON.stringify(entry.metadata ?? {}),
    });
  }
}
