/**
 * Minimal fetch wrapper for the admin API.
 *
 * Every request goes through here so cookies, JSON parsing, and error
 * handling are uniform. `api()` returns the parsed JSON body or throws on a
 * non-2xx response.
 */

/**
 * The base path the app is mounted under (e.g. `/admin`), injected by the
 * server into `window.__TSIR_BASE_PATH__`. Empty string when mounted at root.
 */
const BASE_PATH: string =
  typeof window !== 'undefined' &&
  typeof (window as unknown as { __TSIR_BASE_PATH__?: string }).__TSIR_BASE_PATH__ === 'string'
    ? (window as unknown as { __TSIR_BASE_PATH__: string }).__TSIR_BASE_PATH__
    : '';

/** Prepend the base path to an API path, unless it is already absolute. */
function resolvePath(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (BASE_PATH === '') return path;
  if (path.startsWith(BASE_PATH)) return path;
  return `${BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(resolvePath(path), {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text === '' ? null : safeJson(text);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
