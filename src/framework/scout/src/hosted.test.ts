/**
 * The three hosted search providers, held to the same port.
 *
 * The point of testing all three against one file is that the *differences* are the bug surface:
 * three auth headers, three URL shapes, three search bodies, three response envelopes. A driver
 * that quietly sends Typesense's body to Meilisearch returns an empty hit list and looks like
 * "search does not work" rather than "the wrong body was sent".
 */

import { describe, expect, test } from 'bun:test';

import { HOSTED_SEARCH_PROVIDERS, HostedSearchError, hostedSearch } from './hosted.ts';
import type { HostedSearchOptions } from './hosted.ts';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A fetch that records what was sent and answers with `reply`. */
function recorder(reply: (call: Call) => { status: number; body: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fake = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const { status, body } = reply(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const base: Omit<HostedSearchOptions, 'provider' | 'host' | 'apiKey'> = {
  collection: 'products',
};

describe('hosted search · one port, three wire shapes', () => {
  test('typesense: x-typesense-api-key, /collections/<name>/documents, per_page body', async () => {
    const { fetch, calls } = recorder(() => ({
      status: 200,
      body: { hits: [{ document: { id: 'p1' }, text_match: 578730123365187745 }] },
    }));
    const engine = hostedSearch({
      ...base,
      provider: 'typesense',
      host: 'https://xxx.a1.typesense.net',
      apiKey: 'ts-key',
      fetch,
    });

    await engine.index({ id: 'p1', fields: { title: 'Hat', body: 'Wool' } });
    const results = await engine.search('hat', 5);

    expect(calls[0]?.url).toBe('https://xxx.a1.typesense.net/collections/products/documents/p1');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.headers['x-typesense-api-key']).toBe('ts-key');
    expect(calls[1]?.url).toBe(
      'https://xxx.a1.typesense.net/collections/products/documents/search',
    );
    expect(calls[1]?.body).toMatchObject({ q: 'hat', per_page: 5 });
    expect(results).toEqual([{ id: 'p1', score: 578730123365187745 }]);
  });

  test('meilisearch: bearer token, POST an array of documents, limit body', async () => {
    const { fetch, calls } = recorder(() => ({
      status: 200,
      body: { hits: [{ id: 'p2' }, { id: 'p3' }] },
    }));
    const engine = hostedSearch({
      ...base,
      provider: 'meilisearch',
      host: 'https://ms-xxx.meilisearch.io',
      apiKey: 'ms-key',
      fetch,
    });

    await engine.index({ id: 'p2', fields: { title: 'Hat' } });
    const results = await engine.search('hat', 10);

    expect(calls[0]?.url).toBe('https://ms-xxx.meilisearch.io/indexes/products/documents');
    // Meilisearch upserts an array, not one object: an object body is silently rejected.
    expect(calls[0]?.body).toEqual([{ id: 'p2', title: 'Hat' }]);
    expect(calls[0]?.headers['authorization']).toBe('Bearer ms-key');
    expect(calls[1]?.url).toBe('https://ms-xxx.meilisearch.io/indexes/products/search');
    expect(calls[1]?.body).toMatchObject({ q: 'hat', limit: 10 });
    expect(results.map((hit) => hit.id)).toEqual(['p2', 'p3']);
  });

  test('algolia: two keys, app id from the hostname, objectID out', async () => {
    const { fetch, calls } = recorder(() => ({
      status: 200,
      body: { hits: [{ objectID: 'p4' }] },
    }));
    const engine = hostedSearch({
      ...base,
      provider: 'algolia',
      host: 'https://abc123-dsn.algolia.net',
      apiKey: 'admin-key',
      searchApiKey: 'search-only-key',
      fetch,
    });

    await engine.index({ id: 'p4', fields: { title: 'Hat' } });
    const results = await engine.search('hat', 3);

    expect(calls[0]?.url).toBe('https://abc123-dsn.algolia.net/1/indexes/products/p4');
    // A search-only key cannot write; the write key is only used when it is the only one given.
    expect(calls[0]?.headers['x-algolia-api-key']).toBe('search-only-key');
    expect(calls[0]?.headers['x-algolia-application-id']).toBe('ABC123');
    expect(calls[1]?.body).toMatchObject({ query: 'hat', hitsPerPage: 3 });
    expect(results[0]?.id).toBe('p4');
  });

  test('remove hits the document URL on all three', async () => {
    for (const [provider, host] of [
      ['typesense', 'https://x.a1.typesense.net'],
      ['meilisearch', 'https://ms-x.meilisearch.io'],
      ['algolia', 'https://abc-dsn.algolia.net'],
    ] as const) {
      const { fetch, calls } = recorder(() => ({ status: 200, body: {} }));
      const engine = hostedSearch({ ...base, provider, host, apiKey: 'k', fetch });
      await engine.remove('p9');
      expect(calls[0]?.method).toBe('DELETE');
      expect(calls[0]?.url).toContain('p9');
    }
  });
});

describe('hosted search · failures are coded, and never carry the key', () => {
  test('a non-2xx is a HostedSearchError naming provider and operation', async () => {
    const { fetch } = recorder(() => ({ status: 401, body: { message: 'Invalid API key' } }));
    const engine = hostedSearch({
      ...base,
      provider: 'typesense',
      host: 'https://x.a1.typesense.net',
      apiKey: 'super-secret',
      fetch,
    });

    let thrown: unknown;
    try {
      await engine.search('x');
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostedSearchError);
    expect(String(thrown)).toContain('401');
    expect(String(thrown)).not.toContain('super-secret');
  });

  test('a 200 with an HTML body is a failure, not an empty result', async () => {
    const fake = (async (): Promise<Response> =>
      new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch;
    const engine = hostedSearch({
      ...base,
      provider: 'meilisearch',
      host: 'https://ms-x.meilisearch.io',
      apiKey: 'k',
      fetch: fake,
    });
    let thrown: unknown;
    try {
      await engine.search('x');
    } catch (error: unknown) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(/not JSON/u);
  });

  test('an unknown provider is refused at construction', () => {
    expect(() =>
      hostedSearch({
        ...base,
        provider: 'elastic' as never,
        host: 'https://x',
        apiKey: 'k',
      }),
    ).toThrow(/unknown hosted search provider/u);
  });

  test('a missing key is refused at construction, with the fix in the message', () => {
    expect(() =>
      hostedSearch({
        ...base,
        provider: 'algolia',
        host: 'https://abc-dsn.algolia.net',
        apiKey: '',
      }),
    ).toThrow(/fromEnv/u);
  });

  test('a malformed algolia host says what the host must look like', () => {
    expect(() =>
      hostedSearch({
        ...base,
        provider: 'algolia',
        host: 'https://search.example.com',
        apiKey: 'k',
      }),
    ).toThrow(/algolia host must look like/u);
  });
});

describe('hosted search · the provider list is the registry', () => {
  test('each shipped provider names a distinct wire shape', () => {
    expect([...HOSTED_SEARCH_PROVIDERS].sort()).toEqual(['algolia', 'meilisearch', 'typesense']);
  });
});
