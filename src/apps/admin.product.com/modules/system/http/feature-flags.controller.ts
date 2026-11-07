/**
 * Feature flags controller — Pennant.
 *
 * Lists all flags and their current state. Admin-only via the session guard.
 */
import { Controller, Get, Patch } from '@tsir/router';
import { token } from '@tsir/container';
import type { FeatureDefinition, FeatureManager } from '@tsir/pennant';

import { registry } from '../registry.ts';

export const featureFlagsControllerToken = token<FeatureFlagsController>('FeatureFlagsController');

@Controller(registry, '/api/features')
export class FeatureFlagsController {
  constructor(private readonly features: FeatureManager) {}

  @Get('/', { guards: ['session', 'superAdmin'], tags: ['features'], operationId: 'features.list' })
  async list(): Promise<{ data: Array<{ name: string; description?: string; active: boolean }> }> {
    const all = await this.features.all();
    const data: Array<{ name: string; description?: string; active: boolean }> = [];
    for (const def of all) {
      const active = await this.features.active(def.name);
      data.push({
        name: def.name,
        ...(def.description !== undefined ? { description: def.description } : {}),
        active,
      });
    }
    return { data };
  }

  @Patch('/:name', {
    guards: ['session', 'superAdmin'],
    tags: ['features'],
    operationId: 'features.toggle',
  })
  async toggle({ params }: { params: { name: string } }): Promise<{
    data: { name: string; description?: string; active: boolean };
  }> {
    const decoded = decodeURIComponent(params.name);
    const def = await this.features.get(decoded);
    if (def === null) {
      throw new Error('Feature not found');
    }
    // Toggle boolean rules: flip the boolean value, or convert to boolean if not already.
    const newRule: FeatureDefinition['rule'] =
      def.rule.type === 'boolean'
        ? { type: 'boolean', value: !def.rule.value }
        : { type: 'boolean', value: true };
    const updated: FeatureDefinition = { ...def, rule: newRule };
    await this.features.define(updated);
    return {
      data: {
        name: updated.name,
        ...(updated.description !== undefined ? { description: updated.description } : {}),
        active: await this.features.active(updated.name),
      },
    };
  }
}
