/**
 * Webhook event construction + verification.
 *
 * Stripe signs webhooks with HMAC-SHA256 over `timestamp.payload`. We verify
 * the signature the same way `stripe.webhooks.constructEvent` does, using the
 * Web Crypto API so the package runs on Cloudflare Workers, AWS Lambda and VPS.
 */
import {
  stripeWebhookBadHeader,
  stripeWebhookBadSignature,
  stripeWebhookBadTimestamp,
  stripeWebhookTooOld,
} from './errors.ts';

export interface WebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  created: number;
}

function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Constant-time byte comparison to avoid a timing side-channel. */
function timingSafeEqual(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av !== undefined && bv !== undefined) diff |= av ^ bv;
  }
  return diff === 0;
}

/**
 * Verify and parse a Stripe webhook.
 *
 * @param rawBody The raw request body (string).
 * @param signatureHeader The `stripe-signature` header value.
 * @param secret The webhook signing secret.
 */
export async function constructWebhookEvent(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<WebhookEvent> {
  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=');
    if (k !== undefined && v !== undefined) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const timestamp = parts['t'];
  const signature = parts['v1'];

  if (timestamp === undefined || signature === undefined) {
    throw stripeWebhookBadHeader();
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = bytesToHex(new Uint8Array<ArrayBuffer>(sigBytes));

  if (!timingSafeEqual(enc.encode(expected), enc.encode(signature))) {
    throw stripeWebhookBadSignature();
  }

  // Allow up to 5 minutes of clock skew.
  if (!/^\d+$/.test(timestamp)) throw stripeWebhookBadTimestamp();
  const age = Date.now() / 1000 - Number(timestamp); // coercion-ok: `t=` is a Unix epoch, regex-guarded above
  if (age > 300) throw stripeWebhookTooOld();

  return JSON.parse(rawBody) as WebhookEvent;
}
