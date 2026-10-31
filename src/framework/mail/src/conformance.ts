/**
 * The transport conformance kit (`CAP-005`).
 *
 * Every transport must satisfy the same four properties, and they are written as **data** — named
 * cases that throw — so a project that writes its own transport (a vendor SDK, an internal relay)
 * can prove it with the same suite this repo runs:
 *
 * ```ts
 * import { mailConformance } from '@tsir/mail/conformance';
 * for (const c of mailConformance({ transport: myTransport(), to: 'qa@example.com' })) test(c.name, c.run);
 * ```
 *
 * The four, and why each one is invisible until it is wrong:
 *
 *   · **A send answers an id.** A transport that returns `undefined` makes every caller invent
 *     one, and the id is the only handle a provider's webhook has.
 *   · **Every recipient is accounted for.** `accepted` plus `rejected` must cover the envelope —
 *     a transport that drops one silently has delivered to some of the people and reported all.
 *   · **A `false` capability refuses.** The kit builds a message that uses the feature and asserts
 *     `assertCarriable` throws, so a driver cannot declare `attachments: false` and then quietly
 *     strip them.
 *   · **Two sends are two sends.** A transport that dedupes by content is a transport that eats the
 *     second receipt, and nothing about the API says it will.
 */

import { assertCarriable } from './mailer.ts';
import { createMessage, type MessageInput } from './message.ts';
import type { DeliveryResult, MailTransport } from './port.ts';

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface MailConformanceOptions {
  readonly transport: MailTransport;
  /** Where the kit sends. Use an address the provider is happy to receive. */
  readonly to: string;
  readonly from?: string | undefined;
  /** Unique per run, so a provider's own dedupe (if any) does not hide the third case. */
  readonly prefix?: string | undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function mailConformance(options: MailConformanceOptions): readonly ConformanceCase[] {
  const { transport } = options;
  const prefix = options.prefix ?? `conformance ${crypto.randomUUID()}`;
  const from = options.from ?? 'conformance@tsir.local';

  const message = (label: string): MessageInput => ({
    to: [options.to],
    subject: `${prefix}: ${label}`,
    text: `This is the ${label} case of the @tsir/mail conformance kit.`,
  });

  const send = async (label: string): Promise<DeliveryResult> =>
    transport.send(createMessage({ from, ...message(label) }));

  return [
    {
      name: 'a send answers an id',
      run: async () => {
        const result = await send('id');
        assert(typeof result.id === 'string' && result.id !== '', 'the delivery result has no id');
      },
    },
    {
      name: 'every envelope recipient is accepted or rejected, never dropped',
      run: async () => {
        const cc = `cc${options.to.slice(options.to.indexOf('@'))}`;
        const composed = createMessage({
          from,
          to: [options.to],
          // A `cc` that is a different address from `to`, or none at all when the provider would
          // receive the same mailbox twice (which `createMessage` refuses on purpose).
          ...(cc === options.to ? {} : { cc: [cc] }),
          subject: `${prefix}: envelope`,
          text: 'envelope case',
        });
        const result = await transport.send(composed);
        const named = new Set(
          [...result.accepted, ...(result.rejected ?? []).map((entry) => entry.email)].map(
            (email) => email.toLowerCase(),
          ),
        );
        for (const address of [...composed.to, ...(composed.cc ?? []), ...(composed.bcc ?? [])]) {
          assert(
            named.has(address.email.toLowerCase()),
            `"${address.email}" is in neither accepted nor rejected`,
          );
        }
      },
    },
    {
      name: 'a capability it declares false is refused, not silently dropped',
      run: async () => {
        const caps = transport.capabilities;
        const cases: { feature: string; message: MessageInput | undefined }[] = [
          {
            feature: 'html',
            message: caps.html ? undefined : { ...message('html'), html: '<p>html</p>' },
          },
          {
            feature: 'attachments',
            message: caps.attachments
              ? undefined
              : {
                  ...message('attachment'),
                  attachments: [{ filename: 'a.txt', content: new TextEncoder().encode('x') }],
                },
          },
          {
            feature: 'customHeaders',
            message: caps.customHeaders
              ? undefined
              : { ...message('header'), headers: { 'X-Kit': 'conformance' } },
          },
          {
            feature: 'tags',
            message: caps.tags ? undefined : { ...message('tag'), tags: { kit: 'conformance' } },
          },
        ];

        for (const entry of cases) {
          if (entry.message === undefined) continue;
          const composed = createMessage({ from, ...entry.message });
          let threw = false;
          try {
            assertCarriable(transport, composed);
          } catch {
            threw = true;
          }
          assert(
            threw,
            `the transport declares capabilities.${entry.feature} false and does not refuse it`,
          );
        }
      },
    },
    {
      name: 'two identical sends are two sends',
      run: async () => {
        const first = await send('twice');
        const second = await send('twice');
        assert(
          first.id !== second.id,
          'two sends answered the same id — the transport is deduplicating',
        );
      },
    },
  ];
}
