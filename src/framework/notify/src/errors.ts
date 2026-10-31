/**
 * `@tsir/notify` error codes (append-only).
 *
 * The codes that carry the design are the refusals:
 *
 *   · `NOTIFY_NO_QUEUE` — a notification is queued **by default**, so a notifier built without a
 *     queue refuses to send instead of quietly sending inline. Both alternatives hide something:
 *     an inline send inside a request is a network call in a transaction, and a silent skip is a
 *     notification nobody was told about.
 *   · `NOTIFY_UNKNOWN_CHANNEL` — the declared names are in the message. A typo in `channels` is a
 *     notification that never arrives on the channel someone believes it does.
 *   · `NOTIFY_NO_BUILDER` — a channel in `channels` with no payload builder is dead code that
 *     reads like delivery.
 *   · `NOTIFY_NOTIFIABLE` — the recipient has no address the channel can use (`email`, `phone`,
 *     `webhookUrl`). Named per field, because "notification failed" is not an address.
 *   · `NOTIFY_WEBHOOK_BLOCKED` — the one channel that takes a URL from data is the one that can be
 *     pointed at `169.254.169.254`, so every host must be on the allowlist.
 *   · `NOTIFY_FORBIDDEN_IN_PRODUCTION` — the `memory` channel reaches nobody; production refuses it
 *     as a target, the same rule `@tsir/mail` applies to `log`.
 */

import { TsirError } from '@tsir/container';

export type NotifyErrorCode =
  | 'NOTIFY_NO_CHANNELS'
  | 'NOTIFY_UNKNOWN_CHANNEL'
  | 'NOTIFY_DUPLICATE_CHANNEL'
  | 'NOTIFY_NO_BUILDER'
  | 'NOTIFY_NO_NOTIFICATIONS'
  | 'NOTIFY_UNKNOWN_NOTIFICATION'
  | 'NOTIFY_DUPLICATE_NOTIFICATION'
  | 'NOTIFY_NO_QUEUE'
  | 'NOTIFY_NOTIFIABLE'
  | 'NOTIFY_INVALID_PAYLOAD'
  | 'NOTIFY_UNSUPPORTED_OPERATION'
  | 'NOTIFY_DELIVERY_FAILED'
  | 'NOTIFY_WEBHOOK_BLOCKED'
  | 'NOTIFY_FORBIDDEN_IN_PRODUCTION'
  | 'NOTIFY_CONFIG_INVALID'
  | 'NOTIFY_UNKNOWN_DRIVER';

const KIND = 'capability';

export function noChannels(): TsirError {
  return new TsirError('NOTIFY_NO_CHANNELS', 'no notification channels are declared', {
    kind: KIND,
    hint: 'declare `notify.channels` in `tsir.js`, or build the list with `channelsFromConfig`',
  });
}

export function unknownChannel(name: string, known: readonly string[]): TsirError {
  return new TsirError('NOTIFY_UNKNOWN_CHANNEL', `unknown notification channel "${name}"`, {
    kind: KIND,
    hint:
      `declared channels: ${known.length === 0 ? 'none' : known.join(', ')} — ` +
      'a channel is never resolved by falling back to another one, because the fallback would silently change where a notification goes',
    context: { channel: name, known: known.join(',') },
  });
}

export function duplicateChannel(name: string): TsirError {
  return new TsirError('NOTIFY_DUPLICATE_CHANNEL', `two channels are both named "${name}"`, {
    kind: KIND,
    hint: 'the channel name is what a notification declares, so a duplicate names two different destinations with one word',
    context: { channel: name },
  });
}

export function noBuilder(notification: string, channel: string): TsirError {
  return new TsirError(
    'NOTIFY_NO_BUILDER',
    `notification "${notification}" declares the channel "${channel}" but has no builder for it`,
    {
      kind: KIND,
      hint: `add \`${channel}\` to the notification, or remove it from \`channels\` — a declared channel with no payload is a delivery that would send nothing`,
      context: { notification, channel },
    },
  );
}

export function strayBuilder(notification: string, channel: string): TsirError {
  return new TsirError(
    'NOTIFY_NO_BUILDER',
    `notification "${notification}" builds a "${channel}" payload but does not declare that channel`,
    {
      kind: KIND,
      hint: `add "${channel}" to \`channels\`, or delete the builder — a payload nobody sends is a feature the tests cannot see`,
      context: { notification, channel },
    },
  );
}

export function channelNotDeclared(
  notification: string,
  channel: string,
  declared: readonly string[],
): TsirError {
  return new TsirError(
    'NOTIFY_UNKNOWN_CHANNEL',
    `notification "${notification}" does not declare the channel "${channel}" (declared: ${declared.join(', ')})`,
    {
      kind: KIND,
      hint: 'send on a channel the notification builds a payload for — `only` narrows the list, it never extends it',
      context: { notification, channel, declared: declared.join(',') },
    },
  );
}

export function nothingSelected(notification: string, declared: readonly string[]): TsirError {
  return new TsirError(
    'NOTIFY_NO_CHANNELS',
    `"${notification}" was narrowed to no channels at all (declared: ${declared.join(', ')})`,
    {
      kind: KIND,
      hint: 'pass a non-empty `only`, or omit it to send on every declared channel',
      context: { notification, declared: declared.join(',') },
    },
  );
}

export function noNotifications(): TsirError {
  return new TsirError('NOTIFY_NO_NOTIFICATIONS', 'no notifications are declared', {
    kind: KIND,
    hint: 'declare them with `defineNotification` and export the list as `notifications` from the app entry',
  });
}

export function unknownNotification(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'NOTIFY_UNKNOWN_NOTIFICATION',
    `unknown notification "${name}" (declared: ${known.length === 0 ? 'none' : known.join(', ')})`,
    {
      kind: KIND,
      hint: 'declare it with `defineNotification` and export the list as `notifications` from the app entry',
      context: { notification: name, known: known.join(',') },
    },
  );
}

export function duplicateNotification(name: string): TsirError {
  return new TsirError(
    'NOTIFY_DUPLICATE_NOTIFICATION',
    `two notifications are both named "${name}"`,
    {
      kind: KIND,
      hint: 'the name travels in the queued delivery and in `notify:preview`, so a duplicate is a delivery nobody can address',
      context: { notification: name },
    },
  );
}

export function noQueue(notification: string, channels: readonly string[]): TsirError {
  return new TsirError(
    'NOTIFY_NO_QUEUE',
    `notification "${notification}" is queued but this notifier has no queue (channels: ${channels.join(', ')})`,
    {
      kind: KIND,
      hint:
        'pass `queue` to `createNotifier`, or send inline with `{ immediately: true }`, or declare the notification `queued: false` — ' +
        'sending inline by default would put a network call inside the request that was supposed to be finished with it',
      context: { notification, channels: channels.join(',') },
    },
  );
}

export function notifiableMissing(channel: string, field: string): TsirError {
  return new TsirError(
    'NOTIFY_NOTIFIABLE',
    `the "${channel}" channel needs a recipient with \`${field}\`, and this notifiable has none`,
    {
      kind: KIND,
      hint: `give the notifiable a \`${field}\` (or return one from the notification's builder); a channel that guesses a recipient is a notification sent to the wrong person`,
      context: { channel, field },
    },
  );
}

export function invalidPayload(channel: string, problem: string): TsirError {
  return new TsirError(
    'NOTIFY_INVALID_PAYLOAD',
    `the "${channel}" payload is not usable: ${problem}`,
    {
      kind: KIND,
      hint: `a payload arrives through a queue as JSON, so it is validated again at the channel: ${problem}`,
      context: { channel, problem },
    },
  );
}

export function unsupportedOperation(channel: string, feature: string): TsirError {
  return new TsirError(
    'NOTIFY_UNSUPPORTED_OPERATION',
    `the "${channel}" channel cannot carry ${feature}`,
    {
      kind: KIND,
      hint:
        `drop it from the payload, or send on a channel that has the capability — ` +
        `\`delivers\`, \`html\` and \`attachments\` are declared per channel and checked before anything is sent`,
      context: { channel, feature },
    },
  );
}

export function deliveryFailed(notification: string, channel: string, detail: string): TsirError {
  return new TsirError(
    'NOTIFY_DELIVERY_FAILED',
    `"${notification}" could not be delivered on "${channel}": ${detail}`,
    {
      kind: KIND,
      hint: "the channel reported the failure and stopped; retrying is the queue's job, not the notifier's",
      context: { notification, channel, detail },
    },
  );
}

export function webhookBlocked(url: string, reason: string): TsirError {
  return new TsirError('NOTIFY_WEBHOOK_BLOCKED', `refusing webhook "${url}": ${reason}`, {
    kind: KIND,
    hint: 'the webhook URL comes from data, so it is checked against `allowHosts` before any request — an allowlist is the SSRF guard',
    context: { url, reason },
  });
}

export function forbiddenInProduction(channel: string): TsirError {
  return new TsirError(
    'NOTIFY_FORBIDDEN_IN_PRODUCTION',
    `the "${channel}" channel does not deliver and is refused in production`,
    {
      kind: KIND,
      hint: 'remove it from `notify.channels`, or send to a channel that reaches the recipient — a notification written to memory is a user who was never told',
      context: { channel },
    },
  );
}

export function configInvalid(channel: string, problem: string, hint?: string): TsirError {
  return new TsirError(
    'NOTIFY_CONFIG_INVALID',
    `notify channel "${channel}" is misconfigured: ${problem}`,
    {
      kind: KIND,
      hint:
        hint ??
        'fix `notify.channels` in `tsir.js`; the block is validated at boot, not at the first send',
      context: { channel },
    },
  );
}

export function unknownDriver(driver: string, known: readonly string[]): TsirError {
  return new TsirError('NOTIFY_UNKNOWN_DRIVER', `unknown notification channel driver "${driver}"`, {
    kind: KIND,
    hint: `declared drivers: ${known.join(', ')}`,
    context: { driver, known: known.join(',') },
  });
}
