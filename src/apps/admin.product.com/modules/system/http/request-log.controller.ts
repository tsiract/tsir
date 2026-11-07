/**
 * Telescope-style request log endpoints.
 *
 * Exposes the `request_logs` table to the admin UI: paginated list with
 * optional method/status filters, and a single-log detail endpoint. All
 * endpoints require an authenticated session.
 */
import { Controller, Get } from '@tsir/router';
import { z } from '@tsir/validate';
import { and, desc, eq } from 'drizzle-orm';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import { type DrizzleDb } from '../../../database.ts';
import { requestLogs } from '../../shared/schema.ts';

export const RequestLogIdParams = z.object({ id: z.string() });

export const requestLogControllerToken = token<RequestLogController>('RequestLogController');

@Controller(registry, '/api/requests')
export class RequestLogController {
  constructor(private readonly drizzle: DrizzleDb) {}

  @Get('/', {
    guards: ['session', 'superAdmin'],
    tags: ['telemetry'],
    operationId: 'requests.list',
  })
  async list({
    query,
  }: {
    query?: { method?: string; status?: string; limit?: string; offset?: string };
  }): Promise<unknown> {
    const DIGITS = /^\d+$/;
    const limitRaw = query?.limit ?? '50';
    const offsetRaw = query?.offset ?? '0';
    const limit = DIGITS.test(limitRaw)
      ? Math.min(200, Math.max(1, Number.parseInt(limitRaw, 10))) // coercion-ok: digits-only query param, regex-guarded
      : 50;
    const offset = DIGITS.test(offsetRaw) ? Math.max(0, Number.parseInt(offsetRaw, 10)) : 0; // coercion-ok: digits-only query param, regex-guarded
    const method = query?.method;
    const status = query?.status;

    const where = and(
      method !== undefined ? eq(requestLogs.method, method.toUpperCase()) : undefined,
      status !== undefined && DIGITS.test(status)
        ? eq(requestLogs.status, Number.parseInt(status, 10)) // coercion-ok: digits-only filter, regex-guarded
        : undefined,
    );

    const base = this.drizzle.select().from(requestLogs);
    const query_ = where !== undefined ? base.where(where) : base;
    const rows = await query_.orderBy(desc(requestLogs.createdAt)).limit(limit).offset(offset);

    return { data: rows };
  }

  @Get('/:id', {
    guards: ['session', 'superAdmin'],
    params: RequestLogIdParams,
    tags: ['telemetry'],
    operationId: 'requests.get',
  })
  async get({ params }: { params: { id: string } }): Promise<unknown> {
    const rows = await this.drizzle
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.id, params.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
