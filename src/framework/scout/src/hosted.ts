/**
 * Hosted search engines — the three worth naming, behind one driver shape.
 *
 * Cloudflare has no search product. There is no `env.SEARCH`, no Workers-native full-text service,
 * and D1's FTS5 (the `sqlite` driver) is the closest thing — real, and enough for a few thousand
 * rows, but a table scan's cousin once the corpus grows past what one database should hold. AWS has
 * OpenSearch, which is a cluster to size, secure and pay for before the first query.
 *
 * So this is the one capability where the honest answer is "a third party", and the field has
 * settled into three. All three speak a REST API with an API key, which is why one driver covers
 * them; what differs is the wire shape, and that is a small, testable adapter each.
 *
 *   · **Typesense** — flat node pricing, ~4 ms median, MIT and self-hostable. The pick when search
 *     is a product feature and billing per query is the thing you cannot afford.
 *   · **Meilisearch** — MIT, typo tolerance and hybrid/semantic search, cloud from ~$23–30/mo. The
 *     pick when relevance matters more than shaving milliseconds.
 *   · **Algolia** — the commercial default, a free Build tier at 10K records / 10K searches, then
 *     pay-per-record-and-query. The pick when search drives revenue and the dashboard matters.
 *
 * Prices move; the shapes do not. Every driver here is `fetch` + a key, so a project can start on
 * Algolia's free tier and leave for Typesense without touching application code — which is the
 * whole point of the port.
 *
 * **Why one `hostedSearch` function with a `provider` field in `tsir.js` rather than three
 * constructors.** These are names an application writes in config, not objects it wires in the
 * entry, so they follow the registry rule (`CAP-006`): a `tsir.js` a startup can read top to
 * bottom beats a `switch` in `app.ts`.
 */

import type { SearchDocument, SearchEngine, SearchResult } from './scout.ts';

export type HostedSearchProvider = 'typesense' | 'meilisearch' | 'algolia';

/** The providers this build knows, by the name a `tsir.js` writes. */
export const HOSTED_SEARCH_PROVIDERS: readonly HostedSearchProvider[] = [
  'typesense',
  'meilisearch',
  'algolia',
];

export interface HostedSearchOptions {
  readonly provider: HostedSearchProvider;
  /** The collection or index every document lands in. */
  readonly collection: string;
  /** `https://xxx.a1.typesense.net`, `https://ms-xxx.meilisearch.io`, `https://xxx-dsn.algolia.net`. */
  readonly host: string;
  /** Resolved from `{ fromEnv: … }` by the caller, never a literal in `tsir.js`. */
  readonly apiKey: string;
  /** `algolia` needs both; Typesense and Meilisearch ignore it. Defaults per provider. */
  readonly searchApiKey?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** A failure a caller can act on, with the provider's own message kept and the key never echoed. */
export class HostedSearchError extends Error {
  constructor(
    readonly provider: HostedSearchProvider,
    readonly operation: 'index' | 'remove' | 'search',
    detail: string,
  ) {
    super(`${provider} ${operation} failed: ${detail}`);
    this.name = 'HostedSearchError';
  }
}

/** The document each provider stores: the id, plus the fields flattened into text. */
function payloadOf(doc: SearchDocument): Record<string, unknown> {
  return { id: doc.id, ...doc.fields };
}

/** How one provider authenticates — three shapes, none of them a secret in a URL. */
function authHeaders(options: HostedSearchOptions, applicationId: string): Record<string, string> {
  switch (options.provider) {
    case 'typesense':
      return { 'x-typesense-api-key': options.apiKey };
    case 'meilisearch':
      return { authorization: `Bearer ${options.apiKey}` };
    case 'algolia':
      return {
        // Algolia splits write and search keys; a project that only searches can pass one.
        'x-algolia-api-key': options.searchApiKey ?? options.apiKey,
        'x-algolia-application-id': applicationId,
      };
  }
}

/** Algolia puts the app id in the hostname: `xxx-dsn.algolia.net` → `xxx`. */
function applicationIdOf(host: string): string {
  const match = /^([a-z0-9]+)-(?:dsn|\d)\.algolia\.net$/iu.exec(new URL(host).hostname);
  if (match?.[1] === undefined) {
    throw new TypeError(
      `algolia host must look like "<APP_ID>-dsn.algolia.net" (or "<APP_ID>-1.algolianet.com"); got ${host}`,
    );
  }
  return match[1].toUpperCase();
}

/** The URL for one operation. Each provider names the collection differently in the path. */
function endpointOf(
  options: HostedSearchOptions,
  operation: 'collection' | 'document' | 'search',
  id?: string,
): string {
  const base = options.host.replace(/\/$/u, '');
  const collection = encodeURIComponent(options.collection);
  switch (options.provider) {
    case 'typesense':
      if (operation === 'collection') return `${base}/collections/${collection}`;
      if (operation === 'document')
        return `${base}/collections/${collection}/documents/${String(id)}`;
      return `${base}/collections/${collection}/documents/search`;
    case 'meilisearch':
      if (operation === 'collection') return `${base}/indexes/${collection}/documents`;
      if (operation === 'document') return `${base}/indexes/${collection}/documents/${String(id)}`;
      return `${base}/indexes/${collection}/search`;
    case 'algolia':
      if (operation === 'document') return `${base}/1/indexes/${collection}/${String(id)}`;
      // Algolia has one object endpoint for both upsert and search, distinguished by body.
      return `${base}/1/indexes/${collection}`;
  }
}

/** The body a search POST needs, per provider — the only part that is genuinely different. */
function searchBody(provider: HostedSearchProvider, query: string, limit: number): unknown {
  switch (provider) {
    case 'typesense':
      return { q: query, query_by: 'title,body', per_page: limit };
    case 'meilisearch':
      return { q: query, limit };
    case 'algolia':
      return { query, hitsPerPage: limit };
  }
}

/**
 * A hit's id, as a string — or `''` when the provider sent something that is not a primitive.
 *
 * `String(value ?? '')` on a nested object yields `"[object Object]"`, which a caller would then
 * look up and never find. Returning `''` makes the row visibly wrong instead of plausibly wrong.
 */
function idOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Read the ids and scores out of a response — three envelopes, one result list. */
function resultsOf(provider: HostedSearchProvider, body: unknown): readonly SearchResult[] {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const truthy = (value: unknown): value is readonly unknown[] => Array.isArray(value);

  switch (provider) {
    case 'typesense': {
      const hits = truthy(record['hits']) ? record['hits'] : [];
      return hits.map((hit) => {
        const entry =
          hit !== null && typeof hit === 'object' ? (hit as Record<string, unknown>) : {};
        const document =
          entry['document'] !== null && typeof entry['document'] === 'object'
            ? (entry['document'] as Record<string, unknown>)
            : {};
        return {
          id: idOf(document['id']),
          // coercion-ok: Typesense's `text_match` is a numeric ranking token; it is never user-typed.
          score: typeof entry['text_match'] === 'number' ? entry['text_match'] : 0,
        };
      });
    }
    case 'meilisearch': {
      const hits = truthy(record['hits']) ? record['hits'] : [];
      return hits.map((hit, index) => {
        const entry =
          hit !== null && typeof hit === 'object' ? (hit as Record<string, unknown>) : {};
        // Meilisearch ranks by position, not by a score it exposes.
        return { id: idOf(entry['id']), score: hits.length - index };
      });
    }
    case 'algolia': {
      const hits = truthy(record['hits']) ? record['hits'] : [];
      return hits.map((hit) => {
        const entry =
          hit !== null && typeof hit === 'object' ? (hit as Record<string, unknown>) : {};
        // Algolia's `_rankingInfo.nbTypos` is inverted for ordering; expose position instead.
        return { id: idOf(entry['objectID']), score: 1 };
      });
    }
  }
}

export function hostedSearch(options: HostedSearchOptions): SearchEngine {
  if (!HOSTED_SEARCH_PROVIDERS.includes(options.provider)) {
    throw new TypeError(
      `unknown hosted search provider "${String(options.provider)}"; use one of ${HOSTED_SEARCH_PROVIDERS.join(', ')}`,
    );
  }
  if (options.collection === '') {
    throw new TypeError(
      'hosted search needs a `collection` — the index name every document lands in',
    );
  }
  if (options.apiKey === '') {
    throw new TypeError(
      'hosted search needs an `apiKey`, and it belongs in the environment: pass `{ fromEnv: … }`',
    );
  }

  // Parsed at construction, not on the first search: a host that cannot be read is a config
  // mistake, and a config mistake belongs at boot where the message is read, not in a request.
  const applicationId = options.provider === 'algolia' ? applicationIdOf(options.host) : '';

  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = async (
    operation: 'index' | 'remove' | 'search',
    url: string,
    init: RequestInit,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...authHeaders(options, applicationId),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
    } catch (error: unknown) {
      throw new HostedSearchError(
        options.provider,
        operation,
        controller.signal.aborted
          ? `timed out after ${String(timeoutMs)} ms`
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new HostedSearchError(
        options.provider,
        operation,
        `${String(response.status)} ${text.slice(0, 200)}`,
      );
    }
    try {
      return text === '' ? {} : JSON.parse(text);
    } catch {
      throw new HostedSearchError(
        options.provider,
        operation,
        'answered with a body that is not JSON — a proxy in front of the provider, not the provider',
      );
    }
  };

  return {
    async index(doc) {
      const body = payloadOf(doc);
      switch (options.provider) {
        case 'typesense':
          await call('index', endpointOf(options, 'document', doc.id), {
            method: 'PUT',
            body: JSON.stringify(body),
          });
          return;
        case 'meilisearch':
          await call('index', endpointOf(options, 'collection'), {
            method: 'POST',
            // Meilisearch takes an array and upserts by primary key.
            body: JSON.stringify([body]),
          });
          return;
        case 'algolia':
          await call('index', endpointOf(options, 'document', doc.id), {
            method: 'PUT',
            body: JSON.stringify(body),
          });
          return;
      }
    },

    async remove(id) {
      await call('remove', endpointOf(options, 'document', id), { method: 'DELETE' });
    },

    async search(query, limit = 20) {
      const body = await call('search', endpointOf(options, 'search'), {
        method: 'POST',
        body: JSON.stringify(searchBody(options.provider, query, limit)),
      });
      return resultsOf(options.provider, body).slice(0, limit);
    },
  };
}
