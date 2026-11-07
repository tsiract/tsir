/**
 * CSRF state tokens for the OAuth flow.
 *
 * State is a signed random token: `base64url(nonce).base64url(ts).base64url(hmac).
 * The caller stores it (cookie or session), passes it to `redirect()`, and
 * verifies it in `callback()`. A tampered state fails verification; a reused
 * state fails if the caller also checks one-time use.
 *
 * The HMAC key is passed to `setStateSecret()` (once, at startup). If never set, a
 * process-local key is generated — fine for single-process dev; for
 * multi-worker, the app MUST set a shared secret via
 * `setStateSecret(secret)` in the app's config.
 *
 * Implemented with the Web Crypto API so this package is runtime-neutral:
 * `crypto.subtle` is available on Node, Bun, Deno, and Cloudflare Workers.
 */

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Text encoder reused for every HMAC call. */
const encoder = new TextEncoder();

/**
 * The HMAC key as a Web Crypto `CryptoKey`. Lazily imported from the
 * process-local secret; replaced when `setStateSecret` is called.
 */
let hmacKey: CryptoKey | null = null;

/** Process-local fallback secret, generated once at module load. */
let secretBytes: Uint8Array<ArrayBuffer> = generateRandomBytes(32);

function generateRandomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

async function importKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Set the HMAC secret used to sign state tokens. Call once at startup.
 * Passing an empty string restores the process-local fallback.
 */
export function setStateSecret(secret: string): void {
  secretBytes = secret.length > 0 ? encoder.encode(secret) : generateRandomBytes(32);
  // Invalidate the cached key; it is re-imported on the next sign/verify.
  hmacKey = null;
}

async function getKey(): Promise<CryptoKey> {
  if (hmacKey === null) {
    hmacKey = await importKey(secretBytes);
  }
  return hmacKey;
}

/** Base64url-encode an ArrayBuffer (no padding). */
function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Hex-encode random bytes for the nonce. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Generate a state token. Returns the opaque string to send to the provider.
 * Async because HMAC signing via `crypto.subtle` is asynchronous.
 */
export async function generateState(): Promise<string> {
  const nonce = hex(generateRandomBytes(16));
  const ts = Date.now().toString(36);
  const payload = `${nonce}.${ts}`;
  const sigBuffer = await crypto.subtle.sign('HMAC', await getKey(), encoder.encode(payload));
  const sig = base64url(sigBuffer);
  return `${payload}.${sig}`;
}

/**
 * Verify a state token's signature and expiry. `true` means valid.
 * Async because HMAC verification via `crypto.subtle` is asynchronous.
 */
export async function verifyState(state: string): Promise<boolean> {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (nonce === undefined || ts === undefined || sig === undefined) return false;

  const payload = `${nonce}.${ts}`;
  const expectedBuffer = await crypto.subtle.sign('HMAC', await getKey(), encoder.encode(payload));
  const expected = base64url(expectedBuffer);
  if (sig !== expected) return false;

  // `ts` is emitted by this module as base-36 digits; reject anything else before parsing.
  if (!/^[0-9a-z]+$/.test(ts)) return false;
  const issued = parseInt(ts, 36); // coercion-ok: base-36 digits from a signed state token, regex-guarded above
  if (Number.isNaN(issued)) return false;
  return Date.now() - issued < STATE_TTL_MS;
}

/**
 * Optional one-time-use store for state tokens. Default in-memory map; projects
 * can supply a Redis/database-backed implementation for multi-worker setups.
 */
export interface StateStore {
  consume(state: string): Promise<boolean> | boolean;
}
