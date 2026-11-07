/**
 * Lambda runs the same HTTP conformance suite as Bun and Cloudflare (DPL-024).
 * The Lambda adapter wraps the same `createFetchHandler` pipeline behind an
 * API Gateway v2 event envelope, so the assertions must pass identically.
 */

import {
  toLambdaHandler,
  decodeBase64,
  encodeBase64,
  type ApiGatewayV2Event,
  type LambdaContextLike,
} from './lambda.ts';
import { createConformanceApp, runHttpConformance } from '../../http/src/conformance-suite.ts';

const app = createConformanceApp();
const handler = toLambdaHandler({ unit: 'http', fetch: async (request) => app(request) });

const context: LambdaContextLike = {
  functionName: 'conformance',
  awsRequestId: 'req-1',
  getRemainingTimeInMillis: () => 30_000,
};

/** Reverse of `requestFromApiGatewayV2`: a `Request` → API Gateway v2 event. */
async function toApiGatewayV2Event(request: Request): Promise<ApiGatewayV2Event> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const cookie = headers['cookie'];
  let cookies: string[] | undefined;
  if (cookie !== undefined) {
    cookies = cookie.split(';').map((c) => c.trim());
    delete headers['cookie'];
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  const body = bytes.length > 0 ? encodeBase64(bytes) : undefined;

  return {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    ...(cookies !== undefined ? { cookies } : {}),
    ...(body !== undefined ? { body, isBase64Encoded: true as const } : {}),
    requestContext: {
      http: { method: request.method, path: url.pathname, sourceIp: '203.0.113.1' },
      requestId: 'req-1',
    },
  };
}

const serve = async (request: Request): Promise<Response> => {
  const event = await toApiGatewayV2Event(request);
  const envelope = await handler(event, context);
  const body = envelope.isBase64Encoded ? decodeBase64(envelope.body) : envelope.body;
  return new Response(body, { status: envelope.statusCode, headers: envelope.headers });
};

runHttpConformance('lambda', serve);
