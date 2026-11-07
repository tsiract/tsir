/**
 * Search controller — Scout.
 *
 * Provides a search endpoint that queries the configured search engine.
 */
import { Controller, Get } from '@tsir/router';
import { z } from '@tsir/validate';
import { token } from '@tsir/container';
import type { SearchEngine } from '@tsir/scout';

import { registry } from '../registry.ts';

export const searchControllerToken = token<SearchController>('SearchController');

export const SearchQuery = z.object({
  q: z.string().min(1),
  limit: z
    .string()
    .regex(/^\d+$/, 'Expected a positive integer')
    .transform((value) => Number(value)) // coercion-ok: regex-guarded digits above
    .refine((n) => n >= 1 && n <= 100, 'limit must be between 1 and 100')
    .optional()
    .default(20),
});

@Controller(registry, '/api/search')
export class SearchController {
  constructor(private readonly engine: SearchEngine) {}

  @Get('/', {
    guards: ['session', 'superAdmin'],
    tags: ['search'],
    operationId: 'search.query',
    query: SearchQuery,
  })
  async search({
    query,
  }: {
    query?: { q?: string; limit?: number };
  }): Promise<{ data: Array<{ id: string; score: number }> }> {
    const q = query?.q ?? '';
    const limit = query?.limit ?? 20;
    const results = await this.engine.search(q, limit);
    return { data: results };
  }
}
