/**
 * The Bun adapter.
 *
 * Everything interesting lives in the Web-standard core; this file exists to
 * convert between Bun's `Server` and a `fetch` handler. Keeping it in its own
 * subpath is what lets `@tsir/http` itself stay free of `bun:` imports.
 */

import type { FetchHandler } from './pipeline.ts';

export interface BunServeOptions {
  readonly port?: number;
  readonly hostname?: string;
  /** Called once the socket is listening. */
  readonly onListen?: (server: { readonly url: string; readonly port: number }) => void;
  readonly onError?: (error: unknown) => void;
}

export interface BunServer {
  readonly port: number;
  readonly url: string;
  stop(closeActive?: boolean): Promise<void>;
}

/**
 * Starts a Bun HTTP server backed by a Tsir fetch handler.
 *
 * The handler is `(Request) => Promise<Response>`, so `Bun.serve` needs no
 * translation at all — the only reason this wrapper exists is lifecycle: the
 * caller gets a handle object that can be awaited on shutdown rather than a raw
 * Bun server reference.
 */
export function serve(handler: FetchHandler, options: BunServeOptions = {}): BunServer {
  const server = Bun.serve({
    port: options.port ?? 3000,
    hostname: options.hostname ?? '0.0.0.0',
    fetch: handler,
    ...(options.onError === undefined
      ? {}
      : {
          error: (error: unknown) => {
            options.onError?.(error);
            return new Response('{"code":"HTP_HANDLER_ERROR"}', {
              status: 500,
              headers: { 'content-type': 'application/problem+json' },
            });
          },
        }),
  });

  // `Bun.serve` types `port` as optional; we always pass one, but the fallback
  // keeps the declared shape honest instead of asserting it away.
  const port = server.port ?? options.port ?? 3000;
  options.onListen?.({ url: server.url.href, port });

  return {
    port,
    url: server.url.href,
    async stop(closeActive = true): Promise<void> {
      await server.stop(closeActive);
    },
  };
}
