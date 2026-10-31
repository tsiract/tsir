/**
 * A synchronous SHA-256, for the two places a logger needs a digest *without* an `await`.
 *
 * `crypto.subtle.digest` is asynchronous, and a log call cannot be: `logger.info` is a `void`
 * statement in the middle of business logic, and making every call site `await` would either change
 * every function signature in an application or produce unhandled promises. So this file implements
 * FIPS 180-4 § 6.2 directly. It is ~70 lines, it is checked against the published vectors in a test,
 * and it is **only** used for pseudonymising PII and for stable fingerprints — secrets are still
 * hashed with WebCrypto (`@tsir/auth`), because a password hash must be slow and this is not.
 *
 * A note on why a real hash and not `hashCode`: a pseudonym for an email is only useful if it
 * cannot be inverted. Emails come from a small, guessable domain, so a 32-bit non-cryptographic hash
 * is a lookup table away from being an email again. SHA-256 truncated to 64 bits is not.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** `sha256(bytes)` as a lowercase hex string. */
export function sha256Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  // Pad to a multiple of 64 bytes: 0x80, then zeroes, then the 64-bit big-endian bit length.
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bitLength = length * 8;
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotr(w[index - 15] ?? 0, 7) ^ rotr(w[index - 15] ?? 0, 18) ^ ((w[index - 15] ?? 0) >>> 3);
      const s1 =
        rotr(w[index - 2] ?? 0, 17) ^ rotr(w[index - 2] ?? 0, 19) ^ ((w[index - 2] ?? 0) >>> 10);
      w[index] = ((w[index - 16] ?? 0) + s0 + (w[index - 7] ?? 0) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + choose + (K[index] ?? 0) + (w[index] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }

  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}

const encoder = new TextEncoder();

/** `sha256(text)`, hex. The string form, which is what a record field always holds. */
export function sha256Text(text: string): string {
  return sha256Hex(encoder.encode(text));
}
