/**
 * The `memory` channel (`@tsir/notify/memory`) — every delivery, kept in a list.
 *
 * It is the channel a test asserts against and the channel `notify:channels` prints a warning
 * about: `delivers: false`, so a production notifier refuses it outright rather than writing a
 * payment receipt into an array that nobody ever reads.
 *
 * The subpath exists for the same reason `@tsir/mail/memory` does — a project's tests import it
 * without pulling a notification registry into a unit test that only wanted to see a payload.
 */

import type { Channel, ChannelCapabilities, ChannelDelivery, ChannelResult } from '../channel.ts';

export interface MemoryChannel extends Channel {
  /** Everything delivered so far, oldest first. */
  sent(): readonly ChannelDelivery[];
  /** The last delivery, or `undefined` when nothing was delivered. */
  last(): ChannelDelivery | undefined;
  /** The deliveries of one notification. */
  find(notification: string): readonly ChannelDelivery[];
  clear(): void;
}

export interface MemoryChannelOptions {
  /** Default `memory`. */
  readonly name?: string | undefined;
  /**
   * Accept `html` and attachments, which a real inbox would refuse. On by default: the channel's job
   * in a test is to record what would have been sent, not to be the destination's policy.
   */
  readonly permissive?: boolean | undefined;
}

export function memoryChannel(options: MemoryChannelOptions = {}): MemoryChannel {
  const captured: ChannelDelivery[] = [];
  const capabilities: ChannelCapabilities =
    options.permissive === false
      ? { delivers: false, html: false, attachments: false }
      : { delivers: false, html: true, attachments: true };

  return {
    name: options.name ?? 'memory',
    driver: 'memory',
    capabilities,
    async send(delivery: ChannelDelivery): Promise<ChannelResult> {
      captured.push(delivery);
      return { accepted: true, id: `memory-${String(captured.length)}`, detail: 'recorded' };
    },
    sent() {
      return captured.slice();
    },
    last() {
      return captured.at(-1);
    },
    find(notification) {
      return captured.filter((delivery) => delivery.notification === notification);
    },
    clear() {
      captured.length = 0;
    },
  };
}
