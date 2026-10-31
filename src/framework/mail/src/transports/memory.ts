/**
 * `memory` — collects messages so a test can assert on them (`MAIL-7`).
 *
 * The transport every application test uses, and the only one whose API is for the *caller* rather
 * than for a provider: `sent()`, `last()`, `find()`. A test that reaches into a provider's fake API
 * is testing the provider; a test that asks the transport what it was handed is testing the
 * application.
 *
 * It is `delivers: false` for the same reason `log` is, and it is refused in production for the
 * same reason: an assertion helper is not a mail server.
 */

import { envelopeOf, type DeliveryResult, type MailMessage, type MailTransport } from '../port.ts';

export interface MemoryTransport extends MailTransport {
  /** Every message it was given, in order. */
  sent(): readonly MailMessage[];
  last(): MailMessage | undefined;
  count(): number;
  /** The first message whose recipient or subject matches — the usual assertion. */
  find(predicate: (message: MailMessage) => boolean): MailMessage | undefined;
  clear(): void;
}

export interface MemoryTransportOptions {
  readonly name?: string | undefined;
}

export function memoryTransport(options: MemoryTransportOptions = {}): MemoryTransport {
  const messages: MailMessage[] = [];

  return {
    name: options.name ?? 'memory',
    capabilities: {
      delivers: false,
      html: true,
      attachments: true,
      customHeaders: true,
      tags: true,
    },
    async send(message: MailMessage): Promise<DeliveryResult> {
      messages.push(message);
      return {
        id: `memory-${String(messages.length)}`,
        accepted: envelopeOf(message).to.map((address) => address.email),
      };
    },
    sent: () => messages,
    last: () => messages.at(-1),
    count: () => messages.length,
    find: (predicate) => messages.find((message) => predicate(message)),
    clear: () => {
      messages.length = 0;
    },
  };
}
