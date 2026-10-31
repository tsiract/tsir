/**
 * The request-time matcher.
 *
 * A segment trie, built once at boot. Matching is O(segments) with backtracking
 * bounded by depth — never a regular expression per request, which is how
 * routers become a CPU line item on Workers.
 *
 * Precedence is fixed and testable: static beats parameter beats wildcard, at
 * every depth, with backtracking when a more specific branch dead-ends.
 */

import type { HttpMethod, RouteEntry, RouteTable } from './types.ts';

export interface RouteParams {
  readonly [name: string]: string;
}

export type MatchResult =
  | {
      readonly kind: 'matched';
      readonly route: RouteEntry;
      readonly params: RouteParams;
      /** True when this answered a HEAD request via the route's GET handler. */
      readonly head: boolean;
    }
  | { readonly kind: 'method-not-allowed'; readonly allow: readonly HttpMethod[] }
  | { readonly kind: 'not-found' }
  /** The path was structurally unusable — e.g. an encoded slash. */
  | { readonly kind: 'bad-path'; readonly reason: string };

interface TrieNode {
  readonly children: Map<string, TrieNode>;
  param: { readonly name: string; readonly node: TrieNode } | null;
  wildcard: TrieNode | null;
  readonly routes: Map<HttpMethod, RouteEntry>;
}

function createNode(): TrieNode {
  return { children: new Map(), param: null, wildcard: null, routes: new Map() };
}

const METHOD_PRECEDENCE: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

export class RouteMatcher {
  readonly #root: TrieNode;
  /** Number of registered routes; 0 means the table was empty. */
  readonly size: number;
  readonly #trailingSlash: 'strict' | 'ignore';

  constructor(table: RouteTable, options: { trailingSlash?: 'strict' | 'ignore' } = {}) {
    this.#root = createNode();
    this.#trailingSlash = options.trailingSlash ?? 'strict';
    this.size = table.routes.length;

    for (const route of table.routes) this.#insert(route);
  }

  #insert(route: RouteEntry): void {
    let node = this.#root;
    for (const segment of route.segments) {
      if (segment === '*') {
        node.wildcard ??= createNode();
        node = node.wildcard;
        continue;
      }
      if (segment.startsWith(':')) {
        // Compile-time ambiguity checks guarantee a single parameter edge; two
        // different names at one position would be the same shape and rejected.
        node.param ??= { name: segment.slice(1), node: createNode() };
        node = node.param.node;
        continue;
      }
      const child = node.children.get(segment);
      if (child === undefined) {
        const created = createNode();
        node.children.set(segment, created);
        node = created;
        continue;
      }
      node = child;
    }
    node.routes.set(route.method, route);
  }

  match(method: HttpMethod, pathname: string): MatchResult {
    const decoded = decodeSegments(pathname, this.#trailingSlash);
    if (decoded === null) return { kind: 'not-found' };
    if (typeof decoded === 'string') return { kind: 'bad-path', reason: decoded };

    const params: Record<string, string> = {};
    const found = this.#walk(this.#root, decoded, 0, params);
    if (found === undefined) return { kind: 'not-found' };

    const route = found.routes.get(method);
    if (route !== undefined) return { kind: 'matched', route, params, head: false };

    // HEAD falls back to GET (RFC 9110 § 9.3.2). The body is discarded by the
    // adapter, not here; a declared HEAD always wins over the fallback.
    if (method === 'HEAD') {
      const getRoute = found.routes.get('GET');
      if (getRoute !== undefined) return { kind: 'matched', route: getRoute, params, head: true };
    }

    const allow = [...found.routes.keys()].sort(
      (a, b) => METHOD_PRECEDENCE.indexOf(a) - METHOD_PRECEDENCE.indexOf(b),
    );
    // A GET route implies HEAD for the Allow header, as it does for matching.
    if (allow.includes('GET') && !allow.includes('HEAD')) {
      allow.splice(allow.indexOf('GET') + 1, 0, 'HEAD');
    }
    return { kind: 'method-not-allowed', allow };
  }

  /**
   * Depth-first with explicit precedence and backtracking.
   *
   * The `params` object is mutated in place and restored on backtrack, so a
   * failed static branch cannot leak a parameter into a successful one.
   */
  #walk(
    node: TrieNode,
    segments: readonly string[],
    index: number,
    params: Record<string, string>,
  ): TrieNode | undefined {
    if (index === segments.length) return node.routes.size > 0 ? node : undefined;

    const segment = segments[index] as string;

    const child = node.children.get(segment);
    if (child !== undefined) {
      const found = this.#walk(child, segments, index + 1, params);
      if (found !== undefined) return found;
    }

    if (node.param !== null) {
      const name = node.param.name;
      const had = Object.hasOwn(params, name);
      const previous = params[name];
      params[name] = segment;
      const found = this.#walk(node.param.node, segments, index + 1, params);
      if (found !== undefined) return found;
      if (had && previous !== undefined) params[name] = previous;
      else delete params[name];
    }

    if (node.wildcard !== null) {
      // `*` swallows the remainder, including nothing at all.
      const rest = segments.slice(index).join('/');
      const had = Object.hasOwn(params, '*');
      const previous = params['*'];
      params['*'] = rest;
      if (node.wildcard.routes.size > 0) return node.wildcard;
      const found = this.#walk(node.wildcard, segments, segments.length, params);
      if (found !== undefined) return found;
      if (had && previous !== undefined) params['*'] = previous;
      else delete params['*'];
    }

    return undefined;
  }
}

/**
 * Splits and decodes a path.
 *
 * Returns a reason string instead of throwing: a malformed request is a 400,
 * not a crash, and the caller decides how to render it.
 */
function decodeSegments(
  pathname: string,
  trailingSlash: 'strict' | 'ignore',
): readonly string[] | string | null {
  let path = pathname;
  if (!path.startsWith('/')) return 'path must start with "/"';

  // Strict mode treats `/files/` as a different resource from `/files`, and there
  // is no route for it. That is a 404, not a 400: the request is well-formed, the
  // resource simply does not exist. Returning `null` says exactly that.
  if (trailingSlash === 'strict' && path.length > 1 && path.endsWith('/')) return null;
  if (trailingSlash === 'ignore') path = path.replace(/\/+$/, '');

  if (path === '/' || path === '') return [];

  const out: string[] = [];
  for (const raw of path.slice(1).split('/')) {
    if (raw === '') return 'empty path segment';
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return `invalid percent-encoding in "${raw}"`;
    }
    // An encoded slash would let a client smuggle a segment boundary past the
    // matcher; decoded first, rejected now.
    if (segment.includes('/') || segment.includes('\\'))
      return 'encoded path separators are not allowed';
    out.push(segment);
  }
  return out;
}

export function createMatcher(
  table: RouteTable,
  options?: { trailingSlash?: 'strict' | 'ignore' },
): RouteMatcher {
  return new RouteMatcher(table, options);
}
