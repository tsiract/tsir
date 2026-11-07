/**
 * Horizon-style queue monitoring endpoints.
 *
 * Exposes the `queue_jobs` and `queue_dead` tables to the admin UI: counts by
 * state, paginated job list (filterable by state), single-job detail, and a
 * retry action for failed jobs.
 */
import { Controller, Get, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import type { QueueMonitor, JobState } from '../services/queue-monitor.ts';

export const QueueIdParams = z.object({ id: z.string() });

export const queueControllerToken = token<QueueController>('QueueController');

@Controller(registry, '/api/queues')
export class QueueController {
  constructor(private readonly monitor: QueueMonitor) {}

  @Get('/counts', {
    guards: ['session', 'superAdmin'],
    tags: ['telemetry'],
    operationId: 'queues.counts',
  })
  async counts(): Promise<unknown> {
    return await this.monitor.countsByState();
  }

  @Get('/jobs', {
    guards: ['session', 'superAdmin'],
    tags: ['telemetry'],
    operationId: 'queues.jobs',
  })
  async list({
    query,
  }: {
    query?: { state?: string; limit?: string; offset?: string };
  }): Promise<unknown> {
    const DIGITS = /^\d+$/;
    const limitRaw = query?.limit ?? '50';
    const offsetRaw = query?.offset ?? '0';
    const limit = DIGITS.test(limitRaw)
      ? Math.min(200, Math.max(1, Number.parseInt(limitRaw, 10))) // coercion-ok: digits-only query param, regex-guarded
      : 50;
    const offset = DIGITS.test(offsetRaw) ? Math.max(0, Number.parseInt(offsetRaw, 10)) : 0; // coercion-ok: digits-only query param, regex-guarded
    const state = query?.state as JobState | undefined;
    const jobs = await this.monitor.listJobs(state, limit, offset);
    return { data: jobs };
  }

  @Get('/jobs/:id', {
    guards: ['session', 'superAdmin'],
    params: QueueIdParams,
    tags: ['telemetry'],
    operationId: 'queues.job',
  })
  async get({ params }: { params: { id: string } }): Promise<unknown> {
    return await this.monitor.getJob(params.id);
  }

  @Post('/jobs/:id/retry', {
    guards: ['session', 'superAdmin'],
    params: QueueIdParams,
    tags: ['telemetry'],
    operationId: 'queues.retry',
  })
  async retry({ params }: { params: { id: string } }): Promise<unknown> {
    const ok = await this.monitor.retryJob(params.id);
    return { retried: ok };
  }
}
