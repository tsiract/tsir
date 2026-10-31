import { describe, expect, test } from 'bun:test';
import { createTestClient, expectProblem } from './client.ts';
import { problemResponse } from '../../http/src/problems.ts';

/** Awaits a promise that must reject, and returns the rejection's message. Fails if it resolves. */
async function caught(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the promise to reject');
}

describe('createTestClient (TST-002)', () => {
  test('hands the handler a real Request built from the path and method', async () => {
    let seen: Request | undefined;
    const client = createTestClient((request) => {
      seen = request;
      return new Response('ok');
    });

    const response = await client.get('/api/users?page=2', { headers: { 'x-trace': 'abc' } });

    expect(await response.text()).toBe('ok');
    expect(seen?.method).toBe('GET');
    expect(seen?.url).toBe('http://tsir.test/api/users?page=2');
    expect(seen?.headers.get('x-trace')).toBe('abc');
  });

  test('json is serialised, and sets the content type unless the caller did', async () => {
    const seen: Request[] = [];
    const client = createTestClient((request) => {
      seen.push(request);
      return new Response(null, { status: 204 });
    });

    await client.post('/api/users', { json: { name: 'Ada' } });
    await client.put('/api/users/1', { json: { name: 'Ada' }, headers: { 'content-type': 'x/y' } });

    expect(seen[0]?.headers.get('content-type')).toBe('application/json');
    expect(await seen[0]?.json()).toEqual({ name: 'Ada' });
    expect(seen[1]?.headers.get('content-type')).toBe('x/y');
  });

  test('every verb reaches the handler with its own method', async () => {
    const methods: string[] = [];
    const client = createTestClient((request) => {
      methods.push(request.method);
      return new Response(null);
    });

    await client.get('/a');
    await client.post('/a');
    await client.put('/a');
    await client.patch('/a');
    await client.delete('/a');

    expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  test('opens no socket: a request to a host nothing listens on still resolves through the handler', async () => {
    const client = createTestClient(() => new Response('local'), { origin: 'http://10.255.255.1' });

    expect(await (await client.get('/')).text()).toBe('local');
  });
});

describe('expectProblem (TST-006)', () => {
  test('passes for a problem with the status and code, and returns the body', async () => {
    const body = await expectProblem(problemResponse('HTP_UNAUTHENTICATED'), {
      status: 401,
      code: 'HTP_UNAUTHENTICATED',
    });

    expect(body['code']).toBe('HTP_UNAUTHENTICATED');
  });

  test('refuses a plain-text error, even with the right status', async () => {
    expect(
      await caught(expectProblem(new Response('nope', { status: 500 }), { status: 500 })),
    ).toContain('application/problem+json');
  });

  test('refuses a wrong status and a wrong code, and names both', async () => {
    const make = (): Response => problemResponse('HTP_UNAUTHENTICATED');

    expect(await caught(expectProblem(make(), { status: 403 }))).toContain('expected status 403');
    expect(await caught(expectProblem(make(), { status: 401, code: 'SOMETHING_ELSE' }))).toContain(
      '"SOMETHING_ELSE"',
    );
  });
});
