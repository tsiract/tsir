import { Controller, Get } from '@tsir/router';
import { token } from '@tsir/container';
import type { Health } from '@tsir/pulse';
import type { Metrics } from '@tsir/pulse';

import { registry } from '../registry.ts';

export const systemControllerToken = token<SystemController>('SystemController');

@Controller(registry, '/system')
export class SystemController {
  constructor(
    private readonly health: Health,
    private readonly metrics: Metrics,
  ) {}

  /** Liveness probe — `tsir doctor` and the platform call this. */
  @Get('/health')
  liveness(): unknown {
    return this.health.liveness();
  }

  /** Readiness probe — runs every health check under a timeout. */
  @Get('/ready')
  async readiness(): Promise<unknown> {
    return await this.health.ready();
  }

  /** In-memory metrics counters and timers. */
  @Get('/metrics')
  metricsz(): unknown {
    return { points: this.metrics.snapshot() };
  }
}
