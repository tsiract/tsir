/**
 * Trace propagation and service credentials (`LNK-006`, `LNK-007`).
 *
 * The two assertions worth guarding: an invalid `traceparent` starts a new trace instead
 * of being echoed, and a credential's secret can never reach a log because the only
 * projection that exists (`redactCredential`) does not contain it.
 */

import { describe, expect, test } from 'bun:test';

import {
  bearerCredentialProvider,
  redactCredential,
  resolveCredential,
  staticCredentialProvider,
  validateCredential,
} from './credentials.ts';
import {
  CORRELATION_HEADER,
  formatTraceparent,
  inboundContext,
  outboundHeaders,
  parseTraceparent,
  TRACEPARENT_HEADER,
} from './trace.ts';
import { createCallContext, type ServiceCredential } from './types.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('traceparent (LNK-006)', () => {
  test('round-trips a valid header', () => {
    const parsed = parseTraceparent(formatTraceparent({ traceId: TRACE, spanId: SPAN }));

    expect(parsed).toEqual({ version: '00', traceId: TRACE, spanId: SPAN, sampled: true });
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: false })).toBe(
      `00-${TRACE}-${SPAN}-00`,
    );
  });

  test('rejects everything the spec rejects, and never throws', () => {
    const invalid = [
      undefined,
      null,
      '',
      'garbage',
      `ff-${TRACE}-${SPAN}-01`, // forbidden version
      `00-${'0'.repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${'0'.repeat(16)}-01`,
      `00-${TRACE}-${SPAN}`, // truncated
      `00-${TRACE.slice(0, 30)}-${SPAN}-01`, // short trace id
    ];

    for (const value of invalid) expect(parseTraceparent(value)).toBeUndefined();
  });

  test('an inbound call without a valid header starts a trace instead of echoing garbage', () => {
    const ctx = inboundContext({
      headers: { [TRACEPARENT_HEADER]: 'nonsense', [CORRELATION_HEADER]: 'job-42' },
      signal: new AbortController().signal,
      traceIdFactory: () => 'f'.repeat(32),
    });

    expect(ctx.traceId).toBe('f'.repeat(32));
    expect(ctx.correlationId).toBe('job-42');
  });

  test('an inbound call with a valid header continues the trace', () => {
    const ctx = inboundContext({
      headers: { [TRACEPARENT_HEADER]: `00-${TRACE}-${SPAN}-01` },
      signal: new AbortController().signal,
    });

    expect(ctx.traceId).toBe(TRACE);
    // With no correlation header, the trace id doubles as the correlation id.
    expect(ctx.correlationId).toBe(TRACE);
  });

  test('outbound headers carry trace + correlation, and override a stale caller value', () => {
    const ctx = createCallContext({
      traceId: TRACE,
      correlationId: 'invoice-import-7',
      headers: { [TRACEPARENT_HEADER]: 'stale', accept: 'application/json' },
    });

    const { headers, spanId } = outboundHeaders(ctx, { spanId: SPAN });

    expect(spanId).toBe(SPAN);
    expect(headers[TRACEPARENT_HEADER]).toBe(`00-${TRACE}-${SPAN}-01`);
    expect(headers[CORRELATION_HEADER]).toBe('invoice-import-7');
    expect(headers['accept']).toBe('application/json');
  });
});

describe('service credentials (LNK-007)', () => {
  const credential: ServiceCredential = {
    id: 'svc-billing-prod',
    scheme: 'bearer',
    headers: { authorization: 'Bearer super-secret-token' },
  };

  test('redaction keeps the id and drops the secret', () => {
    const safe = redactCredential(credential);

    expect(safe).toEqual({ id: 'svc-billing-prod', scheme: 'bearer' });
    expect(JSON.stringify(safe)).not.toContain('super-secret-token');
  });

  test('a static provider returns the credential, and validates it once', async () => {
    const provider = staticCredentialProvider(credential);
    const resolved = await resolveCredential(
      provider,
      createCallContext({}),
      'https://billing.test',
    );

    expect(resolved?.id).toBe('svc-billing-prod');
  });

  test('a bearer provider can refresh its token per call', async () => {
    let issued = 0;
    const provider = bearerCredentialProvider({
      id: 'svc-rotating',
      token: () => `token-${String((issued += 1))}`,
    });

    const first = await resolveCredential(provider, createCallContext({}), 'https://billing.test');
    const second = await resolveCredential(provider, createCallContext({}), 'https://billing.test');

    expect(first?.headers['authorization']).toBe('Bearer token-1');
    expect(second?.headers['authorization']).toBe('Bearer token-2');
  });

  test('the context credential wins over the provider', async () => {
    const provider = staticCredentialProvider(credential);
    const override: ServiceCredential = {
      id: 'tenant-42',
      scheme: 'bearer',
      headers: { authorization: 'Bearer tenant-token' },
    };

    const resolved = await resolveCredential(
      provider,
      createCallContext({ credentials: override }),
      'https://billing.test',
    );
    expect(resolved?.id).toBe('tenant-42');
  });

  test('header injection and empty values are configuration errors', () => {
    const forms: ServiceCredential[] = [
      { id: 'x', scheme: 'bearer', headers: { authorization: 'Bearer a\r\nX-Evil: 1' } },
      { id: 'x', scheme: 'bearer', headers: { authorization: '   ' } },
      { id: '', scheme: 'bearer', headers: { authorization: 'Bearer a' } },
    ];

    for (const form of forms) {
      expect(() => validateCredential(form)).toThrow(/LNK_INVALID_CONFIG|header injection|empty/);
    }
  });

  test('no provider and no context credential means an unauthenticated call', async () => {
    expect(
      await resolveCredential(undefined, createCallContext({}), 'https://x.test'),
    ).toBeUndefined();
  });
});
