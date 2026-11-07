/**
 * Client-side Echo-style helper.
 *
 * Connects to a WebSocket URL and exposes:
 *   · `channel(name)` — public channel
 *   · `private(name)` — private channel (prefixes `private-`)
 *   · `join(name)` — presence channel (prefixes `presence-`, with member tracking)
 *
 * A private or presence channel supports `whisper(event, data)`, which is sent to the
 * server and forwarded to other subscribers as `client-<event>`.
 */

export interface EchoChannel {
  listen(event: string, fn: (data: unknown) => void): EchoChannel;
  unsubscribe(): void;
}

export interface EchoPrivateChannel extends EchoChannel {
  whisper(event: string, data: unknown): EchoPrivateChannel;
}

export interface EchoPresenceChannel extends EchoPrivateChannel {
  here(fn: (members: readonly unknown[]) => void): EchoPresenceChannel;
  joining(fn: (member: unknown) => void): EchoPresenceChannel;
  leaving(fn: (member: unknown) => void): EchoPresenceChannel;
}

export interface EchoOptions {
  url: string;
  /** Auth token sent as a query param. */
  authToken?: string;
}

export interface EchoInstance {
  channel(name: string): EchoChannel;
  private(name: string): EchoPrivateChannel;
  join(name: string): EchoPresenceChannel;
  disconnect(): void;
}

const PRIVATE_PREFIX = 'private-';
const PRESENCE_PREFIX = 'presence-';

export function createEcho(options: EchoOptions): EchoInstance {
  const url = options.authToken
    ? `${options.url}?token=${encodeURIComponent(options.authToken)}`
    : options.url;
  const ws = new WebSocket(url);

  /** channel → event → set of listeners */
  const channels = new Map<string, Map<string, Set<(data: unknown) => void>>>();
  /** presence channel → { here, joining, leaving } callbacks */
  const presenceHandlers = new Map<
    string,
    {
      here?: (members: readonly unknown[]) => void;
      joining?: (member: unknown) => void;
      leaving?: (member: unknown) => void;
    }
  >();

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as {
        channel: string;
        event: string;
        data: unknown;
      };
      const handlers = presenceHandlers.get(msg.channel);
      if (handlers !== undefined) {
        if (msg.event === 'pusher:subscription_succeeded') {
          handlers.here?.((msg.data as { members: readonly unknown[] }).members);
          return;
        }
        if (msg.event === 'pusher:member_added') {
          handlers.joining?.(msg.data);
          return;
        }
        if (msg.event === 'pusher:member_removed') {
          handlers.leaving?.(msg.data);
          return;
        }
      }
      const channel = channels.get(msg.channel);
      if (channel === undefined) return;
      const fns = channel.get(msg.event);
      if (fns === undefined) return;
      for (const fn of fns) fn(msg.data);
    } catch {
      // ignore malformed
    }
  });

  function ensureOpenThen(fn: () => void) {
    if (ws.readyState === WebSocket.OPEN) fn();
    else ws.addEventListener('open', fn, { once: true });
  }

  function ensureChannel(name: string): Map<string, Set<(data: unknown) => void>> {
    let listeners = channels.get(name);
    if (listeners === undefined) {
      listeners = new Map();
      channels.set(name, listeners);
      ensureOpenThen(() => ws.send(JSON.stringify({ subscribe: name })));
    }
    return listeners;
  }

  function baseChannel(name: string): EchoChannel {
    const listeners = ensureChannel(name);
    return {
      listen(event, fn) {
        let set = listeners.get(event);
        if (set === undefined) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(fn);
        return this;
      },
      unsubscribe() {
        channels.delete(name);
        presenceHandlers.delete(name);
        ensureOpenThen(() => ws.send(JSON.stringify({ unsubscribe: name })));
      },
    };
  }

  function channel(name: string): EchoChannel {
    return baseChannel(name);
  }

  function privateChannel(name: string): EchoPrivateChannel {
    const full = `${PRIVATE_PREFIX}${name}`;
    const base = baseChannel(full);
    return {
      ...base,
      whisper(event, data) {
        ensureOpenThen(() => ws.send(JSON.stringify({ whisper: { channel: full, event, data } })));
        return this;
      },
    };
  }

  function join(name: string): EchoPresenceChannel {
    const full = `${PRESENCE_PREFIX}${name}`;
    const base = baseChannel(full);
    const handlers: {
      here?: (members: readonly unknown[]) => void;
      joining?: (member: unknown) => void;
      leaving?: (member: unknown) => void;
    } = {};
    presenceHandlers.set(full, handlers);
    return {
      ...base,
      whisper(event, data) {
        ensureOpenThen(() => ws.send(JSON.stringify({ whisper: { channel: full, event, data } })));
        return this;
      },
      here(fn) {
        handlers.here = fn;
        return this;
      },
      joining(fn) {
        handlers.joining = fn;
        return this;
      },
      leaving(fn) {
        handlers.leaving = fn;
        return this;
      },
    };
  }

  return {
    channel,
    private: privateChannel,
    join,
    disconnect() {
      ws.close();
    },
  };
}
