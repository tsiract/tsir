/**
 * Webhook signatures (`§ 4.4`).
 *
 * A webhook that is not signed is a request your endpoint cannot tell from anyone else's, and a
 * webhook without a timestamp can be replayed forever. Both are cheap to prevent and expensive to
 * notice, so both are part of the channel rather than advice in a comment.
 *
 * The scheme is the one Stripe made familiar, written out so a receiver can implement it in twenty
 * lines without a library:
 *
 * ```
 * x-tsir-signature: t=1730000000,v1=5f2c…      (hex HMAC-SHA256 of `${t}.${body}`)
 * ```
 *
 * Two properties matter and are both tested: the timestamp is **inside** the signed string (so it
 * cannot be edited), and verification compares in constant time (so a wrong signature takes the
 * same time to reject as a nearly-right one).
 */

const encoder = new TextEncoder();

/** `t=<unix seconds>,v1=<hex>` for `body`. */
export async function signBody(input: {
  readonly secret: string;
  readonly body: string;
  readonly timestamp: number;
}): Promise<string> {
  const seconds = Math.floor(input.timestamp / 1000);
  const signature = await hmac(input.secret, `${String(seconds)}.${input.body}`);
  return `t=${String(seconds)},v1=${signature}`;
}

/** Parse the header back into its parts; `undefined` when it is not the shape above. */
export function parseSignature(
  header: string,
): { readonly timestamp: number; readonly signature: string } | undefined {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const index = piece.indexOf('=');
    if (index <= 0) return undefined;
    parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  const raw = parts.get('t');
  const signature = parts.get('v1');
  if (raw === undefined || signature === undefined) return undefined;
  // coercion-ok: `t` is matched against `^\d+$` on the line above, so this is a decimal integer by
  // construction — the range is a unix timestamp in seconds, far inside 2^53.
  const timestamp = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(timestamp)) return undefined;
  return { timestamp, signature };
}

/**
 * Verify a header against a body — what an endpoint does on the other side, and what the package's
 * own tests do, so the scheme is known to be verifiable rather than merely plausible.
 *
 * `toleranceMs` (default 5 minutes) refuses a replay. A receiver that wants no replay window at all
 * can pass `0`, which makes every request refuse — deliberately awkward rather than surprising.
 */
export async function verifySignature(input: {
  readonly header: string;
  readonly body: string;
  readonly secret: string;
  readonly now?: number | undefined;
  readonly toleranceMs?: number | undefined;
}): Promise<boolean> {
  const parsed = parseSignature(input.header);
  if (parsed === undefined) return false;

  const now = input.now ?? Date.now();
  const toleranceMs = input.toleranceMs ?? 300_000;
  if (Math.abs(now - parsed.timestamp * 1000) > toleranceMs) return false;

  const expected = await hmac(input.secret, `${String(parsed.timestamp)}.${input.body}`);
  return constantTimeEquals(expected, parsed.signature);
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compare without an early exit: the failure path must not leak how far it got. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
