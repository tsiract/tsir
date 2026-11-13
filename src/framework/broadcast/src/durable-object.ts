/**
 * `durableObjectBroadcaster` — Cloudflare's own fan-out point: a Durable Object.
 *
 * Workers cannot hold a process-wide listener list, because there is no process: two isolates
 * serving two requests share nothing, so `memoryBroadcaster` on Workers publishes into an array
 * nobody else can see. The platform's answer is a Durable Object — one instance per channel, a
 * single-threaded actor that every isolate can reach by name. That is what this driver talks to.
 *
 * **Why this is a client seam and not a Durable Object implementation.** `@tsir/broadcast` cannot
 * import `cloudflare:workers` or `@cloudflare/workers-types`: the first exists only inside a
 * Worker, and the second is a 2 MB type dump that would make every bundle that mentions broadcast
 * depend on the Workers runtime. So the app supplies the namespace binding, and the Durable Object
 * class itself lives in the app — it needs the WebSocket hibernation API, which is app-shaped.
 *
 * The contract is deliberately two methods wide:
 *
 *   · `fetch` — the standard `DurableObjectStub`, so the binding needs no adapter at all.
 *   · the object answers `POST /publish` with `{ channel, event, data }` and fans it out.
 *
 * A hub object holds the sockets and the subscription list; the isolate that publishes never sees
 * a subscriber. `subscribe` therefore hands the object's stream to the caller rather than keeping
 * a local callback — which is why this driver says so in its capabilities.
 */

import type { BroadcastMessage, Broadcaster, ChannelSubscriber } from './broadcaster.ts';

/** The slice of a Durable Object namespace this driver needs. */
export interface DurableObjectNamespaceLike {
  /** `env.REALTIME.idFromName(...)` — the Cloudflare shape, not something we invented. */
  idFromName(name: string): unknown;
  /** The stub. `fetch` is the only method used, which is why no adapter is required. */
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

export interface DurableObjectBroadcasterOptions {
  /** The `[[durable_objects.bindings]]` binding, e.g. `env.REALTIME`. */
  readonly namespace: DurableObjectNamespaceLike;
  /** Which object a channel lands on. Default: the channel name, so one object per channel. */
  readonly objectName?: ((channel: string) => string) | undefined;
  /** Prepended to the object's URL space. Default `/broadcast`. */
  readonly path?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
}

const REQUIRED: readonly (keyof DurableObjectNamespaceLike)[] = ['idFromName', 'get'];

/**
 * A hub Durable Object, as the driver expects it.
 *
 * Exported as source text rather than a class: the app writes this into its Worker entry, because
 * only that file can `export { RealtimeHub }` for `wrangler.toml` to find. Shipping it here as a
 * string keeps `@tsir/broadcast` free of `cloudflare:workers` while still making the object's
 * protocol the framework's contract instead of the app's guesswork.
 *
 * The protocol is small on purpose: `POST /publish` broadcasts, `POST /subscribe` opens a stream
 * of frames, `GET /` reports how many sockets the hub holds.
 */
export const DURABLE_OBJECT_HUB = `import { DurableObject } from 'cloudflare:workers';

export class RealtimeHub extends DurableObject {
  #sockets = new Set<WebSocket>();

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname.endsWith('/publish')) {
      const body = await request.json();
      this.#fan(body);
      return new Response(null, { status: 204 });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/subscribe')) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const socket = {
        send: (frame) => writer.write(encoder.encode(JSON.stringify(frame) + '\\n')),
      };
      this.#sockets.add(socket);
      request.signal.addEventListener('abort', () => {
        this.#sockets.delete(socket);
        void writer.close();
      });
      return new Response(readable, {
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }

    return new Response(JSON.stringify({ sockets: this.#sockets.size }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  #fan(message) {
    for (const socket of this.#sockets) {
      socket.send(message);
    }
  }
}
`;

export function durableObjectBroadcaster(options: DurableObjectBroadcasterOptions): Broadcaster {
  const missing = REQUIRED.filter((name) => typeof options.namespace[name] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `durable object broadcaster namespace is missing required methods: ${missing.join(', ')}`,
    );
  }

  const prefix = (options.path ?? '/broadcast').replace(/\/$/u, '');
  const objectName = options.objectName ?? ((channel: string): string => channel);
  /** One in-flight subscription per channel per isolate; a second caller shares it. */
  const streams = new Map<string, AbortController>();
  const listeners = new Map<string, Set<ChannelSubscriber>>();

  const stubFor = (channel: string): { fetch: typeof fetch } => {
    const stub = options.namespace.get(options.namespace.idFromName(objectName(channel)));
    // The stub's `fetch` is the platform's, not the global: call it bound to the stub.
    return { fetch: stub.fetch.bind(stub) as typeof fetch };
  };

  const attach = (channel: string): void => {
    if (streams.has(channel)) return;
    const controller = new AbortController();
    streams.set(channel, controller);

    const read = async (): Promise<void> => {
      const stub = stubFor(channel);
      let response: Response;
      try {
        response = await stub.fetch(`${prefix}/subscribe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel }),
          signal: controller.signal,
        });
      } catch {
        // A hub that cannot be reached drops this isolate's subscription rather than throwing
        // into a `publish` that already succeeded. The next `subscribe` call re-attaches.
        streams.delete(channel);
        return;
      }
      if (response.body === null) {
        streams.delete(channel);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line !== '') {
              const message = JSON.parse(line) as BroadcastMessage;
              for (const fn of listeners.get(message.channel) ?? []) fn(message);
            }
            newline = buffer.indexOf('\n');
          }
        }
      } catch {
        // Aborted by the last `unsubscribe`, or the connection dropped. Either way it re-attaches
        // on the next `subscribe`.
      } finally {
        streams.delete(channel);
      }
    };

    void read();
  };

  return {
    async publish(channel, event, data) {
      const stub = stubFor(channel);
      const response = await stub.fetch(`${prefix}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, event, data }),
      });
      if (!response.ok) {
        throw new TypeError(
          `durable object hub refused a publish for "${channel}": ${String(response.status)}`,
        );
      }
    },

    subscribe(channel, fn) {
      let own = listeners.get(channel);
      if (own === undefined) {
        own = new Set();
        listeners.set(channel, own);
      }
      own.add(fn);
      attach(channel);
      return () => {
        own?.delete(fn);
        if (own.size === 0) {
          listeners.delete(channel);
          streams.get(channel)?.abort();
          streams.delete(channel);
        }
      };
    },
  };
}
