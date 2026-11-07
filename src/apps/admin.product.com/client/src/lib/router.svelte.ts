/**
 * A tiny client-side router for the admin SPA.
 *
 * - History API navigation (`pushState` + `popstate`) so URLs are dynamic.
 * - Query params are first-class: `router.query` is a reactive `URLSearchParams`.
 * - View Transitions API: route changes are wrapped in
 *   `document.startViewTransition()` when available.
 *
 * State is held in a single exported `$state` object; the router mutates its
 * properties (never reassigns the export), which keeps reactivity across the
 * whole app.
 */
export interface RouteMatch {
  readonly path: string;
  readonly component: unknown;
  readonly params: Readonly<Record<string, string>>;
}

export interface RouteDef {
  readonly path: string;
  readonly component: unknown;
}

const routes: RouteDef[] = [];

/**
 * The base path the app is mounted under (e.g. `/admin`), injected by the
 * server into `window.__TSIR_BASE_PATH__`. Empty string when mounted at root.
 */
const BASE_PATH: string =
  typeof window !== 'undefined' &&
  typeof (window as unknown as { __TSIR_BASE_PATH__?: string }).__TSIR_BASE_PATH__ === 'string'
    ? (window as unknown as { __TSIR_BASE_PATH__: string }).__TSIR_BASE_PATH__
    : '';

/** Strip the base path from a raw location pathname for route matching. */
function stripBase(pathname: string): string {
  if (BASE_PATH === '') return pathname;
  if (pathname === BASE_PATH) return '/';
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return pathname;
}

/** Prepend the base path to a navigation target. */
function withBase(path: string): string {
  if (BASE_PATH === '') return path;
  if (path.startsWith(BASE_PATH)) return path;
  return `${BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;
}

const initialPath = typeof location !== 'undefined' ? stripBase(location.pathname) : '/';

export const router = $state({
  pathname: initialPath,
  search: typeof location !== 'undefined' ? location.search : '',
  current: null as RouteMatch | null,
  query: new URLSearchParams(typeof location !== 'undefined' ? location.search : ''),
});

function matchRoute(target: string): RouteMatch | null {
  for (const route of routes) {
    const segs = route.path.split('/').filter(Boolean);
    const parts = target.split('/').filter(Boolean);
    if (segs.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (segs[i] !== parts[i]) ok = false;
    }
    if (ok) return { path: route.path, component: route.component, params };
  }
  return null;
}

export function registerRoutes(defs: readonly RouteDef[]): void {
  routes.length = 0;
  for (const def of defs) routes.push(def);
  router.current = matchRoute(router.pathname);
}

function recompute(): void {
  router.current = matchRoute(router.pathname);
  router.query = new URLSearchParams(router.search);
}

export function navigate(to: string): void {
  const target = withBase(to);
  const url = new URL(target, location.origin);
  if (stripBase(url.pathname) === router.pathname && url.search === router.search) return;
  const run = () => {
    history.pushState(null, '', url);
    router.pathname = stripBase(url.pathname);
    router.search = url.search;
    recompute();
  };
  // `startViewTransition` must be called with `document` as `this`, otherwise
  // the browser throws "Illegal invocation". Bind it explicitly.
  const start = document.startViewTransition?.bind(document);
  if (typeof start === 'function') start(run);
  else run();
}

export function setQuery(updater: (q: URLSearchParams) => void): void {
  const q = new URLSearchParams(router.search);
  updater(q);
  const next = q.toString();
  const qs = next === '' ? '' : `?${next}`;
  const url = `${withBase(router.pathname)}${qs}`;
  history.replaceState(null, '', url);
  router.search = qs;
  recompute();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    router.pathname = stripBase(location.pathname);
    router.search = location.search;
    recompute();
  });
}
