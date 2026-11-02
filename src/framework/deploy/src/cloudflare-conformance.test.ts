/**
 * Cloudflare Workers runs the same HTTP conformance suite as Bun and Lambda
 * (DPL-024). The Worker adapter wraps the same `createFetchHandler` pipeline,
 * so the assertions must pass identically.
 */

import { toCloudflareHandler } from './cloudflare.ts';
import { createConformanceApp, runHttpConformance } from '../../http/src/conformance-suite.ts';

const app = createConformanceApp();
const worker = toCloudflareHandler({
  unit: 'http',
  fetch: async (request) => app(request),
});

const serve = (request: Request): Promise<Response> => {
  if (worker.fetch === undefined) throw new Error('worker has no fetch');
  return worker.fetch(request, {}, { waitUntil: () => {} });
};

runHttpConformance('cloudflare', serve);
