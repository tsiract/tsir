/**
 * The search conformance kit, tested two ways.
 *
 * First **every shipped engine passes**, which is the claim the kit makes to a driver author.
 * Then — the half that matters — **every case fails for a broken engine**. A conformance kit whose
 * cases all pass against a stub is a kit that certifies nothing, and this repository has already
 * shipped one guard that no code path reached.
 */
import { describe, expect, test } from 'bun:test';

import { conformanceCases } from './conformance.ts';
import { hostedSearch } from './hosted.ts';
import { memoryEngine, type SearchDocument, type SearchEngine } from './scout.ts';

/** Run every case and return the ones that threw, by name. */
async function failuresOf(engine: SearchEngine, prefix = 'kit'): Promise<string[]> {
  const failures: string[] = [];
  for (const conformanceCase of conformanceCases({ engine, prefix })) {
    try {
      await conformanceCase.run();
    } catch {
      failures.push(conformanceCase.name);
    }
  }
  return failures;
}

/**
 * A deliberately broken engine, in the shape each case is meant to catch.
 *
 * `broken` names the rules this one violates; everything else it does correctly, so a case only
 * fails when the fault it exists for is present.
 */
function brokenEngine(fault: 'appends' | 'empty-returns-all' | 'remove-throws'): SearchEngine {
  const docs = new Map<string, SearchDocument>();
  const tokenize = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean);
  const match = (doc: SearchDocument, terms: readonly string[]): number => {
    const haystack = tokenize(Object.values(doc.fields).join(' '));
    return terms.filter((term) => haystack.includes(term)).length;
  };
  return {
    async index(doc) {
      if (fault === 'appends') {
        // Keeps the old fields under a second key that still points at the same id — the shape of
        // an index that appends rather than replaces.
        const existing = [...docs.values()].filter((entry) => entry.id === doc.id);
        docs.set(`${doc.id}#${String(existing.length)}`, doc);
        return;
      }
      docs.set(doc.id, doc);
    },
    async remove(id) {
      if (fault === 'remove-throws') throw new Error('404 not found');
      docs.delete(id);
    },
    async search(query, limit = 20) {
      const terms = tokenize(query);
      if (terms.length === 0 && fault === 'empty-returns-all') {
        return [...docs.values()].map((doc) => ({ id: doc.id, score: 1 }));
      }
      if (terms.length === 0) return [];
      return [...docs.values()]
        .map((doc) => ({ id: doc.id, score: match(doc, terms) }))
        .filter((result) => result.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },
  };
}

describe('search conformance · reachable from the package entry', () => {
  test('the kit is exported from both the root and `@tsir/scout/conformance`', async () => {
    // A conformance kit nobody can import is documentation. The package entry is where a driver
    // author looks, and the subpath is where the cache kit already lives — so both have to work,
    // or one of the two readers gets a compile error.
    const root = await import('./index.ts');
    expect(typeof root.conformanceCases).toBe('function');
    const entries = JSON.parse(
      await Bun.file(new URL('../package.json', import.meta.url)).text(),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(entries.exports)).toContain('./conformance');
  });
});

describe('search conformance · the shipped engines pass', () => {
  test('memoryEngine', async () => {
    expect(await failuresOf(memoryEngine())).toEqual([]);
  });

  test('hostedSearch over a fake fetch, all three providers', async () => {
    // The hosted engines are the reason the kit exists: they are the ones talking to a service, and
    // this is the only way to hold them to the same contract as the in-process one without a
    // network. The double implements enough of each wire shape to be honest.
    for (const provider of ['typesense', 'meilisearch', 'algolia'] as const) {
      expect(
        await failuresOf(
          hostedSearch({
            provider,
            // Algolia's app id lives in the hostname and the driver validates it — a made-up
            // `appid.algolia.net` throws at construction, which is correct and is why this test
            // failed until the host looked like a real one.
            host:
              provider === 'algolia'
                ? 'https://abc123-dsn.algolia.net'
                : provider === 'meilisearch'
                  ? 'https://ms-abc.meilisearch.io'
                  : 'https://abc.a1.typesense.net',
            apiKey: 'k',
            collection: 'books',
            fetch: fakeHostedFetch(),
          }),
        ),
      ).toEqual([]);
    }
  });
});

describe('search conformance · the kit fails a broken engine', () => {
  test('an engine that appends instead of replacing fails the re-index case', async () => {
    const failures = await failuresOf(brokenEngine('appends'));
    expect(failures).toContain('re-indexing the same id replaces the document');
  });

  test('an engine that returns everything for an empty query fails that case', async () => {
    const failures = await failuresOf(brokenEngine('empty-returns-all'));
    expect(failures).toContain('a query with no terms returns nothing, not everything');
  });

  test('an engine whose remove throws on a missing id fails idempotency', async () => {
    const failures = await failuresOf(brokenEngine('remove-throws'));
    expect(failures).toContain('remove is idempotent — removing an absent id is not an error');
  });

  test('a good engine fails nothing, so the cases above are not failing for a shared reason', async () => {
    // The control. Without it, the three cases above would pass if the kit threw for every engine.
    expect(await failuresOf(memoryEngine())).toEqual([]);
  });
});

/**
 * A fetch double that behaves like a real index, for all three providers at once.
 *
 * Written against the four wire shapes the drivers actually use — not a generic REST guess — because
 * its whole value is that a driver bug and a double bug are distinguishable. The path conventions
 * come from `endpointOf` and the envelopes from `resultsOf`:
 *
 *   · Typesense   `PUT|DELETE /collections/<c>/documents/<id>`, `POST …/documents/search`
 *   · Meilisearch `POST /indexes/<c>/documents` (an array), `DELETE …/documents/<id>`, `POST …/search`
 *   · Algolia     `PUT|DELETE /1/indexes/<c>/<id>`, `POST /1/indexes/<c>` for search
 */
function fakeHostedFetch(): typeof fetch {
  const docs = new Map<string, Record<string, string>>();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  /** Whole-word matching, which is what the hosted services do. */
  const matches = (record: Record<string, string>, query: string): number => {
    const haystack = Object.values(record)
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/u);
    return query
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean)
      .filter((term) => haystack.includes(term)).length;
  };
  const search = (query: string): { id: string; score: number }[] =>
    [...docs.entries()]
      .map(([id, record]) => ({ id, score: matches(record, query) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score);

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    const body: unknown =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

    // Algolia has one object endpoint for both upsert and search, distinguished by method: a `POST`
    // to the collection *is* the search. That is why it cannot be recognised by the path alone.
    const isSearch =
      path.endsWith('/documents/search') ||
      path.endsWith('/search') ||
      (method === 'POST' && /\/1\/indexes\/[^/]+$/u.test(path));
    // A `PUT` to the same path is an upsert — read before `isSearch` is used.

    if (isSearch) {
      // Narrow before stringifying: `String(record['q'])` on an object yields `"[object Object]"`,
      // which would silently search for that literal. The double only ever receives a string here,
      // so a non-string is a bug in the driver being tested and an empty query is the loud answer.
      const raw = record['q'] ?? record['query'];
      const query = typeof raw === 'string' ? raw : '';
      // Meilisearch ranks by position and exposes no score; the other two carry a token.
      if (path.includes('/indexes/') && !path.includes('/1/indexes/')) {
        return json({ hits: search(query).map((hit) => ({ id: hit.id })) });
      }
      if (path.includes('/1/indexes/')) {
        return json({ hits: search(query).map((hit) => ({ objectID: hit.id })) });
      }
      return json({
        hits: search(query).map((hit) => ({
          document: { id: hit.id },
          text_match: hit.score,
        })),
      });
    }

    if (method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop() ?? '');
      // A real service answers 404 for a document that is not there, which is the case
      // the idempotency case exists for.
      if (!docs.has(id)) return json({ message: 'Not Found' }, 404);
      docs.delete(id);
      return json({ deleted: true });
    }

    if (method === 'POST' || method === 'PUT') {
      const entries = Array.isArray(body) ? body : [body];
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const candidate = entry as Record<string, string>;
        const id = candidate['id'] ?? candidate['objectID'] ?? path.split('/').pop();
        if (id === undefined) continue;
        // Replace, not append: the same id indexed twice is one document with the new fields.
        docs.set(String(id), { ...candidate });
      }
      return json({ ok: true }, method === 'POST' ? 201 : 200);
    }
    return json({}, 200);
  }) as typeof fetch;
}
