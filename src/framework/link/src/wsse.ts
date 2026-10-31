/**
 * WS-Security `UsernameToken` (`LNK-019`).
 *
 * The profile is small and the parts that matter are the ones people get wrong:
 *
 *   · **`PasswordDigest` is a hash over three concatenated byte strings**, not a
 *     double-encoded string: `Base64(SHA-1(nonce ‖ created ‖ password))`, where `nonce` is
 *     the *decoded* bytes and `created` is the exact timestamp string that travels in the
 *     header. Hash the wrong one of those and the server rejects a correct password.
 *   · **`created` bounds replay.** A token with no freshness window is a password in a
 *     header forever, so verification enforces a maximum age (and refuses timestamps from
 *     the future beyond a small skew).
 *   · **Digest is not a substitute for TLS.** It hides the password from logs and from a
 *     casual reader of the message, but it is replayable within the window and SHA-1 is
 *     broken for collision resistance (not for this use). `PasswordText` is accepted only
 *     when the caller says the transport is trusted.
 *
 * X.509 signing and `BinarySecurityToken` are deliberately absent: § 5 requires a vetted
 * implementation and a security review first, and canonicalization is where hand-rolled
 * XML security goes wrong.
 */

import type { CallError } from './types.ts';
import { callError } from './errors.ts';
import { childNamed, serializeXml, textOf, xmlElement, type XmlElement } from './xml.ts';

const WSSE_NAMESPACE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU_NAMESPACE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const TOKEN_PROFILE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
const BASE64_ENCODING =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export type PasswordMode = 'text' | 'digest';

export interface UsernameTokenOptions {
  readonly username: string;
  /** Resolved by the caller — a vault read, not a config value, in production. */
  readonly password: string;
  /** Default `digest`. `text` requires TLS, which the client checks at construction. */
  readonly mode?: PasswordMode | undefined;
  /** Test seams: a fixed nonce and timestamp make the digest deterministic. */
  readonly nonce?: Uint8Array | undefined;
  readonly created?: Date | undefined;
}

/** Freshness window for a received token. Five minutes, with one minute of skew. */
export const DEFAULT_TOKEN_MAX_AGE_MS = 300_000;
export const DEFAULT_CLOCK_SKEW_MS = 60_000;

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
  const binary = atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** `Base64(SHA-1(nonce ‖ created ‖ password))` — the one line the profile is about. */
export async function passwordDigest(
  nonce: Uint8Array,
  created: string,
  password: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const createdBytes = encoder.encode(created);
  const passwordBytes = encoder.encode(password);
  const joined = new Uint8Array(nonce.length + createdBytes.length + passwordBytes.length);
  joined.set(nonce, 0);
  joined.set(createdBytes, nonce.length);
  joined.set(passwordBytes, nonce.length + createdBytes.length);

  const digest = await crypto.subtle.digest('SHA-1', joined);
  return base64Encode(new Uint8Array(digest));
}

/** A 16-byte nonce from the platform CSPRNG. */
export function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  return nonce;
}

/** The `wsse:Security` header element for a call. */
export async function securityHeader(
  options: UsernameTokenOptions,
  header: {
    readonly mustUnderstand?: boolean | undefined;
    /** The envelope namespace, so the header can declare the prefix it uses itself. */
    readonly envelopeNamespace?: string | undefined;
  } = {},
): Promise<XmlElement> {
  const mode = options.mode ?? 'digest';
  const created = (options.created ?? new Date()).toISOString();
  const nonce = options.nonce ?? randomNonce();
  const password =
    mode === 'digest' ? await passwordDigest(nonce, created, options.password) : options.password;

  const token = xmlElement('wsse:UsernameToken', {
    children: [
      xmlElement('wsse:Username', { children: [{ text: options.username }] }),
      xmlElement('wsse:Password', {
        attributes: {
          Type: `${TOKEN_PROFILE}#Password${mode === 'digest' ? 'Digest' : 'Text'}`,
        },
        children: [{ text: password }],
      }),
      // `Nonce` and `Created` are what make the digest unrepeatable; sending a digest
      // without them is a static hash of the password, which is worse than text.
      xmlElement('wsse:Nonce', {
        attributes: { EncodingType: BASE64_ENCODING },
        children: [{ text: base64Encode(nonce) }],
      }),
      xmlElement('wsu:Created', { children: [{ text: created }] }),
    ],
  });

  const declaresSoap = header.mustUnderstand !== false && header.envelopeNamespace !== undefined;

  return xmlElement('wsse:Security', {
    attributes: {
      'xmlns:wsse': WSSE_NAMESPACE,
      'xmlns:wsu': WSU_NAMESPACE,
      // Only claim `mustUnderstand` when we can bind the prefix that spells it: a
      // `soap:mustUnderstand` attribute with no `xmlns:soap` in scope is not XML.
      ...(declaresSoap ? { 'xmlns:soap': header.envelopeNamespace ?? '' } : {}),
      ...(header.mustUnderstand === false ? {} : { 'soap:mustUnderstand': '1' }),
    },
    children: [token],
  });
}

export interface UsernameTokenVerifier {
  /** Look up the password for a user. `undefined` means "no such user" — not an error to log. */
  readonly passwordFor: (username: string) => string | undefined | Promise<string | undefined>;
  /** Default: accepts both modes. Digest-only deployments set `['digest']`. */
  readonly modes?: readonly PasswordMode[] | undefined;
  readonly now?: (() => number) | undefined;
  readonly maxAgeMs?: number | undefined;
  readonly clockSkewMs?: number | undefined;
}

export type UsernameTokenResult =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly error: CallError };

/**
 * Verifies a `wsse:Security` element (or the `UsernameToken` inside it).
 *
 * Failures are values: an unauthenticated request is a normal outcome on the wire, and
 * the caller decides what a `CallError` becomes in its own protocol's fault shape.
 */
export async function verifyUsernameToken(
  header: XmlElement,
  verifier: UsernameTokenVerifier,
): Promise<UsernameTokenResult> {
  const security = header.localName === 'Security' ? header : undefined;
  const token =
    security === undefined
      ? childNamed(header, 'UsernameToken')
      : childNamed(security, 'UsernameToken');

  if (token === undefined) {
    return unauthenticated('the Security header carries no UsernameToken');
  }

  const username = childNamed(token, 'Username');
  const passwordElement = childNamed(token, 'Password');
  if (username === undefined || passwordElement === undefined) {
    return unauthenticated('UsernameToken is missing Username or Password');
  }

  const claimed = textOf(passwordElement);
  const type = passwordElement.attributes['Type'] ?? '';
  const mode: PasswordMode = type.endsWith('#PasswordDigest') ? 'digest' : 'text';
  const allowed = verifier.modes ?? ['digest', 'text'];
  if (!allowed.includes(mode)) {
    return unauthenticated(`Password${mode === 'digest' ? 'Digest' : 'Text'} is not accepted here`);
  }

  const nonceElement = childNamed(token, 'Nonce');
  const createdElement = childNamed(token, 'Created');

  if (mode === 'digest' && (nonceElement === undefined || createdElement === undefined)) {
    return unauthenticated('PasswordDigest requires both Nonce and Created');
  }
  if (createdElement !== undefined) {
    const freshness = checkFreshness(textOf(createdElement), verifier);
    if (freshness !== undefined) return { ok: false, error: freshness };
  }

  const user = textOf(username);
  const expectedPassword = await verifier.passwordFor(user);
  if (expectedPassword === undefined) {
    // The same work as a real verification, so "no such user" is not an oracle.
    await passwordDigest(new Uint8Array(16), 'x', 'y');
    return unauthenticated('invalid username or password');
  }

  if (mode === 'text') {
    if (!timingSafeEqual(claimed, expectedPassword)) {
      return unauthenticated('invalid username or password');
    }
    return { ok: true, username: user };
  }

  let nonce: Uint8Array;
  try {
    nonce = base64Decode(textOf(nonceElement ?? xmlElement('Nonce')));
  } catch {
    return unauthenticated('Nonce is not valid base64');
  }

  const expected = await passwordDigest(
    nonce,
    textOf(createdElement ?? xmlElement('Created')),
    expectedPassword,
  );
  if (!timingSafeEqual(claimed, expected)) {
    return unauthenticated('invalid username or password');
  }

  return { ok: true, username: user };
}

function checkFreshness(created: string, verifier: UsernameTokenVerifier): CallError | undefined {
  const now = (verifier.now ?? Date.now)();
  const stamp = Date.parse(created);
  if (Number.isNaN(stamp)) return unauthenticatedError('Created is not an ISO 8601 timestamp');

  const maxAge = verifier.maxAgeMs ?? DEFAULT_TOKEN_MAX_AGE_MS;
  const skew = verifier.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  if (now - stamp > maxAge) {
    return unauthenticatedError(`token is older than the ${String(maxAge)} ms freshness window`);
  }
  if (stamp - now > skew) {
    return unauthenticatedError(`token timestamp is ${String(stamp - now)} ms in the future`);
  }
  return undefined;
}

function unauthenticatedError(message: string): CallError {
  return callError('unauthenticated', 'LNK_UNAUTHENTICATED', { message, retryable: false });
}

function unauthenticated(message: string): UsernameTokenResult & { ok: false } {
  return { ok: false, error: unauthenticatedError(message) };
}

/** Length-independent, value-safe comparison of two base64 digests. */
function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/** Only used by tests and by `tsir link:soap:gen` output to preview a header. */
export function serializeSecurityHeader(header: XmlElement): string {
  return serializeXml(header);
}
