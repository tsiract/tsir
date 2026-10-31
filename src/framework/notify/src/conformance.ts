/**
 * The channel conformance kit (`CAP-005`).
 *
 * Every channel must satisfy the same four properties, written as **data** — named cases that
 * throw — so a project that writes its own channel (a vendor SDK, an internal relay) can prove it
 * with the same suite this repo runs:
 *
 * ```ts
 * import { channelConformance } from '@tsir/notify/conformance';
 * for (const c of channelConformance({ channel: myChannel(), payload: { … } })) test(c.name, c.run);
 * ```
 *
 * The four, and why each is invisible until it is wrong:
 *
 *   · **A delivery answers an id or a sentence.** `accepted: true` with neither is a delivery an
 *     operator cannot look up.
 *   · **Capabilities are declared, not implied.** All three booleans exist and `delivers` agrees
 *     with the channel's own `driver` name — the one fact production reads to refuse `memory`.
 *   · **A payload it cannot use is refused, and refused as a `TsirError`.** A channel that threw a
 *     bare `Error` would surface as an unhandled crash in a worker rather than a coded failure.
 *   · **Two deliveries are two deliveries.** A channel that dedupes by content eats the second
 *     notification, and nothing about the port says it will.
 */

import { TsirError } from '@tsir/container';

import type { Channel, ChannelDelivery, ChannelResult, Notifiable } from './channel.ts';

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface ChannelConformanceOptions {
  readonly channel: Channel;
  /** A payload this channel accepts. */
  readonly payload: unknown;
  /** A recipient with whatever this channel addresses (`email`, `phone`, `id`, `webhookUrl`). */
  readonly to?: Notifiable | undefined;
  /** A payload it must refuse — enables the refusal case; skipped when omitted. */
  readonly badPayload?: unknown;
  /** Unique per run, so a provider's own dedupe cannot hide the fourth case. */
  readonly prefix?: string | undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function channelConformance(options: ChannelConformanceOptions): readonly ConformanceCase[] {
  const { channel } = options;
  const prefix = options.prefix ?? `conformance ${crypto.randomUUID()}`;
  const to = options.to ?? {
    id: `conformance-${prefix}`,
    email: 'conformance@tsir.local',
    phone: '+15550000000',
    webhookUrl: 'https://example.com/conformance',
  };

  const deliver = (label: string, payload = options.payload): Promise<ChannelResult> => {
    const delivery: ChannelDelivery = {
      deliveryId: `${prefix}:${label}`,
      notification: 'conformance.delivery',
      to,
      payload,
      at: Date.now(),
    };
    return channel.send(delivery);
  };

  const cases: ConformanceCase[] = [
    {
      name: 'a delivery answers an id or a sentence',
      run: async () => {
        const result = await deliver('id');
        assert(result.accepted === true, 'the delivery was not accepted');
        assert(
          (typeof result.id === 'string' && result.id !== '') ||
            (typeof result.detail === 'string' && result.detail !== ''),
          'the delivery result has neither an id nor a detail',
        );
      },
    },
    {
      name: 'capabilities are declared as booleans, and deliver what the driver claims',
      run: () => {
        const caps = channel.capabilities;
        for (const key of ['delivers', 'html', 'attachments'] as const) {
          assert(typeof caps[key] === 'boolean', `capability "${key}" is not a boolean`);
        }
        // `memory` is the only built-in that does not deliver; a channel named `memory` that claims
        // otherwise would be accepted in production, which is the one thing the flag prevents.
        if (channel.driver === 'memory') {
          assert(caps.delivers === false, 'the memory driver claims to deliver');
        }
        return Promise.resolve();
      },
    },
    {
      name: 'two deliveries are two deliveries',
      run: async () => {
        const first = await deliver('twice:1');
        const second = await deliver('twice:2');
        assert(first.accepted && second.accepted, 'one of two deliveries was not accepted');
      },
    },
  ];

  if (options.badPayload !== undefined) {
    const badPayload = options.badPayload;
    cases.push({
      name: 'a payload it cannot use is refused, with a code',
      run: async () => {
        // A channel that declares `check` is asked directly: that is the path the notifier uses
        // before anything is queued.
        if (channel.check !== undefined) {
          try {
            channel.check(badPayload);
          } catch (error: unknown) {
            assertRefusal(error, channel.name);
            return;
          }
          throw new Error('the channel accepted a payload it cannot use');
        }

        // Otherwise the port's promise is the whole check: `send` refuses it, either by answering
        // `accepted: false` or by throwing a coded error.
        let result: ChannelResult;
        try {
          result = await deliver('bad', badPayload);
        } catch (error: unknown) {
          assertRefusal(error, channel.name);
          return;
        }
        assert(result.accepted === false, 'a refused payload was accepted');
      },
    });
  }

  return cases;
}

function assertRefusal(error: unknown, channel: string): void {
  assert(
    error instanceof TsirError && error.code.startsWith('NOTIFY_'),
    `channel "${channel}" refused a bad payload with something that is not a NOTIFY_ code: ${String(error)}`,
  );
}
