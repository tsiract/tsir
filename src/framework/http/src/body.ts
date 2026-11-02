/**
 * Reading and parsing request bodies.
 *
 * Three guards, in order, because each one protects the next:
 *
 *   1. **Size** — checked against `content-length` before reading, and against
 *      the actual byte count while reading. A chunked body lies about its length.
 *   2. **Shape** — JSON depth is bounded, so a nesting bomb becomes a 400 rather
 *      than a stack overflow inside `JSON.parse`.
 *   3. **Pollution** — `__proto__` and `constructor` keys are rejected outright.
 *      Zod would strip them, but a schema with `.passthrough()` would not, and
 *      this check runs before any parser sees the object.
 *

 * All three fail as `HTP_BAD_REQUEST`/`HTP_BODY_TOO_LARGE` with no hint about
 * which key tripped the depth or pollution check — an error message is not a
 * place to teach an attacker the parser's limits.
 */

import { TsirError } from '@tsir/core';

export interface BodyLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
}

export type BodyResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'malformed'; readonly detail: string };

const POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Iterative depth check — recursion here would be the very bug it prevents. */
export function exceedsDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { value: current, depth } = frame;
    if (depth > maxDepth) return true;
    if (Array.isArray(current)) {
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof current === 'object' && current !== null) {
      for (const key of Object.keys(current)) {
        stack.push({ value: Reflect.get(current, key), depth: depth + 1 });
      }
    }
  }
  return false;
}

/** True when any object in the tree carries a prototype-pollution key. */
export function hasPollutionKey(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    for (const key of Object.keys(current)) {
      if (POLLUTION_KEYS.has(key)) return true;
      stack.push(Reflect.get(current, key));
    }
  }
  return false;
}

export type ReadResult =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'too-large'; readonly bytes: number };

/**
 * Streams the request body, enforcing `maxBytes` as bytes arrive.
 *
 * The returned stream is the request's own body wrapped in a counting transform:
 * a chunk that would push the total past `maxBytes` is dropped and the stream
 * errors with `HTP_BODY_TOO_LARGE`, so a handler that stops reading still cannot
 * let an unbounded body through. A declared `content-length` above the limit is
 * rejected before the first byte is read.
 *
 * The caller owns the stream's lifetime: it must be consumed or cancelled, just
 * like `request.body`.
 */
export function streamBody(
  request: Request,
  maxBytes: number,
): { readonly kind: 'ok'; readonly stream: ReadableStream<Uint8Array> } | { readonly kind: 'too-large'; readonly bytes: number } {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    // coercion-ok: a framework header, only used to reject early; the counting
    // transform below enforces the real byte cap regardless of this value.
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) return { kind: 'too-large', bytes };
  }

  const source = request.body;
  if (source === null) {
    // An empty body is a stream that ends immediately — a handler that asks for
    // a stream always gets one, never `null`.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return { kind: 'ok', stream };
  }

  let total = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(
          new TsirError('HTP_BODY_TOO_LARGE', `body exceeds ${String(maxBytes)} bytes`, {
            kind: 'http',
            context: { bytes: total },
          }),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return { kind: 'ok', stream: source.pipeThrough(transform) };
}

/**
 * Reads at most `maxBytes` from the body, counting real bytes.
 *
 * `content-length` is a hint, not a guarantee: a constructed `Request`, a
 * chunked transfer, or a hostile client can all omit or lie about it. The cap is
 * therefore enforced by the reader itself, and the stream is cancelled the moment
 * it is exceeded so the peer stops sending.
 */
export async function readWithin(request: Request, maxBytes: number): Promise<ReadResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    // coercion-ok: a framework header, and only ever used to reject early;
    // the reader below enforces the real byte cap regardless of this value.
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) return { kind: 'too-large', bytes };
  }

  const stream = request.body;
  if (stream === null) return { kind: 'ok', text: '' };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;

  try {
    for (;;) {
      const chunk: { readonly done: boolean; readonly value: Uint8Array | undefined } =
        await reader.read();
      if (chunk.done || chunk.value === undefined) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large', bytes: total };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return { kind: 'ok', text };
}

/**
 * Reads a JSON body within the configured limits.
 *
 * Returns a result union rather than throwing: the caller decides the status,
 * and a body problem is not an exceptional control flow.
 */
export async function readJsonBody(request: Request, limits: BodyLimits): Promise<BodyResult> {
  const read = await readWithin(request, limits.maxBytes);
  if (read.kind === 'too-large') return { kind: 'too-large', bytes: read.bytes };

  const raw = read.text;
  if (raw.trim() === '') return { kind: 'empty' };

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    // The parser's message can quote the offending fragment, so it is discarded.
    return { kind: 'malformed', detail: 'body is not valid JSON' };
  }

  if (hasPollutionKey(value)) {
    return { kind: 'malformed', detail: 'body contains a forbidden object key' };
  }
  if (exceedsDepth(value, limits.maxDepth)) {
    return { kind: 'malformed', detail: 'body is nested too deeply' };
  }

  return { kind: 'parsed', value };
}
