/**
 * Codecs (`§ 4.1`): the only place a payload becomes bytes and back.
 *
 * The rule this package states — "no implicit `JSON.parse` of unknown payloads" — is enforced
 * structurally rather than by discipline: a `Cache<T>` can only be built from a `Codec<T>`,
 * and the backend below it hands back `string`. There is no `get<T>()` with a type argument
 * to lie to; the type comes from the store's declaration, once.
 *
 * Two codecs ship here. `json` is the default because JSON is the only format every runtime
 * in scope parses without a dependency. `string` exists so a store that only ever holds
 * small text does not pay for quotes — and so the tests can prove that a codec mismatch is a
 * named error rather than a mystery.
 */

import { codecFailed } from './errors.ts';
import type { Codec } from './port.ts';

/**
 * JSON, with a **version tag** on the envelope.
 *
 * The tag is what turns "someone changed the shape of this value" into a readable refusal
 * instead of `undefined` flowing into application code. It costs eight bytes.
 */
export interface JsonEnvelope {
  readonly $tsir: 1;
  readonly v: unknown;
}

export function json<T>(): Codec<T> {
  return {
    name: 'json',
    encode(value: T): string {
      // `undefined` is the port's word for "miss" (`get` returns `undefined`), so storing it
      // would make a hit indistinguishable from an absence. It is refused instead.
      if (value === undefined) {
        throw new TypeError('`undefined` is a cache miss, not a value');
      }
      const encoded = JSON.stringify({ $tsir: 1, v: value } satisfies JsonEnvelope);
      // `JSON.stringify` also returns `undefined` for a function or a symbol.
      if (encoded === undefined) {
        throw new TypeError('this value has no JSON representation');
      }
      return encoded;
    },
    decode(raw: string): T {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !('$tsir' in parsed)) {
        throw new TypeError('not a tsir JSON envelope');
      }
      const envelope = parsed as Partial<JsonEnvelope>;
      if (envelope.$tsir !== 1) {
        throw new TypeError(`envelope version ${String(envelope.$tsir)} is not 1`);
      }
      if (!('v' in envelope)) {
        throw new TypeError('envelope has no value');
      }
      return envelope.v as T;
    },
    counter: {
      // A counter written by an older build may be a bare integer; reading it is not an
      // "implicit parse of an unknown payload" — the counter format is exactly this.
      read(raw: string): number | undefined {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'number') return parsed;
        if (typeof parsed === 'object' && parsed !== null && '$tsir' in parsed) {
          const value = (parsed as Partial<JsonEnvelope>).v;
          return typeof value === 'number' ? value : undefined;
        }
        return undefined;
      },
      write: (value: number): string =>
        JSON.stringify({ $tsir: 1, v: value } satisfies JsonEnvelope),
    },
  };
}

/** Raw text. Round-trips exactly, including the empty string. */
export function text(): Codec<string> {
  return {
    name: 'text',
    encode: (value: string): string => value,
    decode: (raw: string): string => raw,
    counter: {
      read(raw: string): number | undefined {
        // coercion-ok: a text store's counter is a decimal integer this codec wrote itself;
        // anything else returns `undefined` and the increment fails, so this is validation.
        const parsed = Number(raw);
        return raw.trim() !== '' && Number.isInteger(parsed) ? parsed : undefined;
      },
      write: (value: number): string => String(value),
    },
  };
}

/**
 * Wrap a codec so a failure names the store and the key.
 *
 * A `JSON.parse` error on its own says "Unexpected token o in JSON at position 1", which
 * tells the person reading the log nothing about *which* store, *which* key, or which codec
 * wrote it. `CAP_CODEC_FAILED` says all three.
 */
export function guardCodec<T>(codec: Codec<T>, store: string, key: string): Codec<T> {
  const describe = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  return {
    name: codec.name,
    encode(value: T): string {
      try {
        return codec.encode(value);
      } catch (error: unknown) {
        throw codecFailed(store, key, describe(error));
      }
    },
    decode(raw: string): T {
      try {
        return codec.decode(raw);
      } catch (error: unknown) {
        throw codecFailed(store, key, `${describe(error)} (written by the "${codec.name}" codec)`);
      }
    },
  };
}
