/**
 * `@tsir/mail` error codes (append-only).
 *
 * Five of these exist because a mail package that is *silent* is the class of bug this port is
 * built to prevent:
 *
 *   · `MAIL_INVALID_ADDRESS` — a header-injection attempt (`\r\nBcc: …`) is refused before any
 *     transport sees it, so an address that came from a form cannot add a header.
 *   · `MAIL_UNSUPPORTED_OPERATION` — a transport that cannot carry an attachment says so, naming
 *     the transport, instead of sending a message without it.
 *   · `MAIL_FORBIDDEN_IN_PRODUCTION` — `log` and `memory` deliver nothing, so production refuses
 *     them as the default (the same rule `@tsir/storage` applies to its memory disk).
 *   · `MAIL_UNKNOWN_TEMPLATE` — the names that exist are in the message. A typo must not be a
 *     blank email.
 *   · `MAIL_TRANSPORT_FAILED` — the provider's status and message, never its credential.
 */

import { TsirError } from '@tsir/container';

export type MailErrorCode =
  | 'MAIL_NO_MAILERS'
  | 'MAIL_UNKNOWN_MAILER'
  | 'MAIL_UNKNOWN_DEFAULT'
  | 'MAIL_DRIVER_MISSING'
  | 'MAIL_CONFIG_INVALID'
  | 'MAIL_INVALID_ADDRESS'
  | 'MAIL_INVALID_MESSAGE'
  | 'MAIL_UNSUPPORTED_OPERATION'
  | 'MAIL_FORBIDDEN_IN_PRODUCTION'
  | 'MAIL_UNKNOWN_TEMPLATE'
  | 'MAIL_TRANSPORT_FAILED';

const KIND = 'capability';

export function unknownMailer(name: string, known: readonly string[]): TsirError {
  return new TsirError('MAIL_UNKNOWN_MAILER', `unknown mailer "${name}"`, {
    kind: KIND,
    hint: `declared mailers: ${known.join(', ')} — a mailer is never resolved by falling back to the default`,
    context: { mailer: name, known: known.join(',') },
  });
}

export function noMailers(): TsirError {
  return new TsirError('MAIL_NO_MAILERS', 'no mailers are declared', {
    kind: KIND,
    hint: 'declare `mail.mailers` in `tsir.js`, or export `mailers` from the app entry',
  });
}

export function unknownDefault(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'MAIL_UNKNOWN_DEFAULT',
    `the default mailer "${name}" is not declared (declared: ${known.join(', ')})`,
    {
      kind: KIND,
      hint: 'set `mail.default` to one of the declared names, or omit it and name the mailer in `tsir.js`',
      context: { default: name, known: known.join(',') },
    },
  );
}

export function driverMissing(
  mailer: string,
  driver: string,
  available: readonly string[],
): TsirError {
  return new TsirError(
    'MAIL_DRIVER_MISSING',
    `mailer "${mailer}" names the driver "${driver}", which this build does not ship`,
    {
      kind: 'config',
      hint: `available drivers: ${available.join(', ')}`,
      context: { mailer, driver },
    },
  );
}

export function configInvalid(mailer: string, reason: string, hint: string): TsirError {
  return new TsirError('MAIL_CONFIG_INVALID', `mailer "${mailer}" is not usable: ${reason}`, {
    kind: 'config',
    hint,
    context: { mailer },
  });
}

/** An address a header parser could be fooled by, or one that is not an address at all. */
export function invalidAddress(input: string, reason: string): TsirError {
  return new TsirError(
    'MAIL_INVALID_ADDRESS',
    `refused the address ${JSON.stringify(input)}: ${reason}`,
    {
      kind: 'validation',
      hint: 'an address is `local@domain` or `Name <local@domain>` — a display name is quoted, never a second header',
      context: { reason },
    },
  );
}

/** A message that would be sent but should not be. */
export function invalidMessage(reason: string, hint: string): TsirError {
  return new TsirError('MAIL_INVALID_MESSAGE', `refused to send: ${reason}`, {
    kind: 'validation',
    hint,
  });
}

export function unsupportedOperation(
  transport: string,
  feature: string,
  detail: string,
): TsirError {
  return new TsirError(
    'MAIL_UNSUPPORTED_OPERATION',
    `transport "${transport}" cannot carry ${feature}: ${detail}`,
    {
      kind: KIND,
      hint: 'check `transport.capabilities` — a `false` capability is a build-time fact, not a warning',
      context: { transport, feature },
    },
  );
}

export function forbiddenInProduction(mailer: string, transport: string): TsirError {
  return new TsirError(
    'MAIL_FORBIDDEN_IN_PRODUCTION',
    `mailer "${mailer}" uses the "${transport}" transport, which delivers nothing — refused in production`,
    {
      kind: KIND,
      hint: 'point the mailer at `resend`, `postmark`, `ses`, `cloudflare` or `smtp`, or set it for development only',
      context: { mailer, transport },
    },
  );
}

export function unknownTemplate(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'MAIL_UNKNOWN_TEMPLATE',
    known.length === 0
      ? `no mail templates are registered, so "${name}" cannot render`
      : `unknown mail template "${name}" (registered: ${known.join(', ')})`,
    {
      kind: KIND,
      hint: 'export `templates` from the app entry, or pass one to `createMailer({ templates })`',
      context: { template: name, known: known.join(',') },
    },
  );
}

/**
 * The provider said no.
 *
 * `status` and the provider's own message are kept; the request — and therefore the credential —
 * is not, because this error is logged and sometimes shown.
 */
export function transportFailed(input: {
  readonly transport: string;
  readonly operation: string;
  readonly status?: number | undefined;
  readonly detail?: string | undefined;
}): TsirError {
  const where = input.status === undefined ? '' : ` (HTTP ${String(input.status)})`;
  return new TsirError(
    'MAIL_TRANSPORT_FAILED',
    `${input.transport} refused ${input.operation}${where}${input.detail === undefined ? '' : `: ${input.detail}`}`,
    {
      kind: 'internal',
      hint: 'the provider message above is theirs; check the key, the verified sender domain and the recipient',
      context: {
        transport: input.transport,
        operation: input.operation,
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    },
  );
}
