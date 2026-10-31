/**
 * `@tsir/mail` — the port.
 *
 * A transport takes one composed message and answers with an id. That is the whole contract, and
 * the three things it deliberately leaves out are the three that make mail packages complicated
 * in ways that hide:
 *
 *   · **No queueing.** `Mailer.send` sends. If a message should be queued, the caller composes a
 *     job (`@tsir/queue`) and the job sends — which is exactly the point: a mail package that
 *     silently queues creates an invisible dependency on a worker being alive, and "the receipt
 *     never arrived" then has nothing to do with mail.
 *   · **No retries.** Retrying is a queue's job, and a transport that retried would multiply the
 *     attempts a queue had already given it. The transport reports the failure and stops.
 *   · **No rendering.** The message reaching a transport is already a `MailMessage` with text and
 *     HTML, because a template is a thing the sender owns and a transport is a thing a provider
 *     owns.
 */

/** One addressee. `name` is a display name, never part of the address. */
export interface MailAddress {
  readonly email: string;
  /** A display name, quoted on the wire when it contains anything a parser would trip on. */
  readonly name?: string | undefined;
}

/** What a `from`/`to` may be written as: a string, or a structured address. */
export type AddressInput = string | MailAddress;

export interface Attachment {
  /** A bare file name. A path here is a refusal, not a directory to create. */
  readonly filename: string;
  readonly content: Uint8Array;
  /** Defaults to `application/octet-stream`, and is never guessed from the extension. */
  readonly contentType?: string | undefined;
  /** `attachment` by default; `inline` is what a `contentId` needs to be referenced. */
  readonly disposition?: 'attachment' | 'inline' | undefined;
  /** The `cid:` a body references. Requires `disposition: 'inline'`. */
  readonly contentId?: string | undefined;
}

/**
 * A composed message. Everything is present that the port promises, so a transport never has to
 * decide what an absent field meant.
 */
export interface MailMessage {
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc?: readonly MailAddress[] | undefined;
  readonly bcc?: readonly MailAddress[] | undefined;
  readonly replyTo?: readonly MailAddress[] | undefined;
  readonly subject: string;
  readonly text?: string | undefined;
  readonly html?: string | undefined;
  /** Extra headers, already validated: reserved names and CR/LF never reach a transport. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly attachments?: readonly Attachment[] | undefined;
  /** Provider tags (`resend`/`postmark`/`ses` all have some form of them). */
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/** Who a provider is being asked to deliver to — `to` + `cc` + `bcc`, in that order. */
export interface Envelope {
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
}

/**
 * What a transport can carry.
 *
 * Declared per transport and enforced by the mailer rather than by the provider: a capability that
 * is `false` must refuse **before** a network call, because the alternative is a message the
 * caller believes was delivered and a provider that quietly dropped the attachment.
 */
export interface TransportCapabilities {
  /**
   * The transport reaches a provider that delivers to a real person.
   *
   * `log` and `memory` are `false`, which is the fact production reads: a project whose default
   * mailer cannot deliver is a project whose password-reset mail goes to a terminal.
   */
  readonly delivers: boolean;
  readonly html: boolean;
  readonly attachments: boolean;
  /** Custom headers survive to the wire. */
  readonly customHeaders: boolean;
  /** Provider tags/labels. */
  readonly tags: boolean;
}

export interface DeliveryResult {
  /** The provider's id, or a locally generated one for `log`/`memory`. */
  readonly id: string;
  /** Every envelope recipient the transport accepted. */
  readonly accepted: readonly string[];
  /** What the provider refused, when it says so. */
  readonly rejected?: readonly { readonly email: string; readonly reason: string }[] | undefined;
}

export interface MailTransport {
  /** `log`, `memory`, `resend`, `postmark`, `ses`, `cloudflare`, `smtp`. */
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  send(message: MailMessage): Promise<DeliveryResult>;
}

/** The recipients a provider is asked to deliver to. */
export function envelopeOf(message: MailMessage): Envelope {
  return {
    from: message.from,
    to: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])],
  };
}

/** `Name <a@b.c>` for one addressee, quoting the name when it needs it. */
export function formatAddress(address: MailAddress): string {
  if (address.name === undefined || address.name === '') return address.email;
  return `${quoteName(address.name)} <${address.email}>`;
}

/** A display name, quoted when it contains a character a header parser treats as syntax. */
function quoteName(name: string): string {
  if (!/["\\()<>\[\]:;@,.]/u.test(name)) return name;
  return `"${name.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export function formatAddresses(addresses: readonly MailAddress[]): string[] {
  return addresses.map((address) => formatAddress(address));
}
