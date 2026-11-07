/**
 * Errors (`CAP-*`).
 *
 * Three of these carry the package:
 *
 *   · `STO_INVALID_KEY` — the key was refused **before** a driver saw it. Path traversal, a
 *     leading slash, a control character: the rules live in one place (`disk.ts`) so the `local`
 *     driver cannot be the only thing standing between a key and `../../etc/passwd`.
 *   · `STO_UNSUPPORTED_OPERATION` — a driver that cannot do what was asked, with the **disk** and
 *     the **driver** in the message. "Signed URLs are not supported" is useless; "disk `assets`
 *     (driver `local`) cannot sign URLs" is a fix.
 *   · `STO_FILESYSTEM_UNAVAILABLE` — the `local` driver on a runtime that has no filesystem. It
 *     has its own code because the alternative is a bundler error about `node:fs` inside a
 *     Worker, which reads like a framework bug rather than like a deployment mistake.
 */

import { TsirError } from '@tsir/container';

export type StorageErrorCode =
  | 'STO_UNKNOWN_DISK'
  | 'STO_NO_DISKS'
  | 'STO_UNKNOWN_DEFAULT'
  | 'STO_DRIVER_MISSING'
  | 'STO_INVALID_KEY'
  | 'STO_UNSUPPORTED_OPERATION'
  | 'STO_ALREADY_EXISTS'
  | 'STO_FORBIDDEN_IN_PRODUCTION'
  | 'STO_FILESYSTEM_UNAVAILABLE'
  | 'STO_SIGNING_FAILED'
  | 'STO_CONFIG_INVALID'
  | 'STO_REQUEST_FAILED'
  | 'STO_NOT_FOUND';

const KIND = 'capability';

/** A disk name nothing declared. Lists what *was* declared, in declaration order. */
export function unknownDisk(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'STO_UNKNOWN_DISK',
    `unknown storage disk "${name}" (declared: ${known.length === 0 ? 'none' : known.join(', ')})`,
    {
      kind: KIND,
      hint: 'declare it under `storage.disks` in tsir.js — an undeclared name never falls back to the default',
      context: { disk: name },
    },
  );
}

export function noDisks(): TsirError {
  return new TsirError('STO_NO_DISKS', 'no storage disks are declared', {
    kind: KIND,
    hint: 'declare one under `storage.disks` in tsir.js, or `createDisks({ disks: { default: defineDisk({ driver: memoryDriver() }) } })`',
    context: {},
  });
}

export function unknownDefault(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'STO_UNKNOWN_DEFAULT',
    `storage.default is "${name}", which is not a declared disk (declared: ${known.join(', ')})`,
    {
      kind: KIND,
      hint: 'a default is a name, not a driver — set `storage.default` to one of the declared disks',
      context: { disk: name },
    },
  );
}

/** A driver name this build does not ship. Lists the ones it does. */
export function driverMissing(name: string, disk: string, available: readonly string[]): TsirError {
  return new TsirError(
    'STO_DRIVER_MISSING',
    `unknown storage driver "${name}" for disk "${disk}" (this build ships: ${available.join(', ')})`,
    {
      kind: KIND,
      hint: 'check the spelling in `storage.disks`, or install the package that provides the driver',
      context: { disk, driver: name },
    },
  );
}

/** A key the port refuses. The `reason` is the rule, not a restatement of it. */
export function invalidKey(key: string, reason: string, disk: string): TsirError {
  return new TsirError(
    'STO_INVALID_KEY',
    `invalid key ${JSON.stringify(key)} on disk "${disk}": ${reason}`,
    {
      kind: KIND,
      hint: 'a key is a relative, slash-separated path: no leading `/`, no `.` or `..` segment, no control characters or backslashes',
      context: { disk, key },
    },
  );
}

/** A capability the driver does not have. Both names, always. */
export function unsupportedOperation(
  operation: string,
  disk: string,
  driver: string,
  detail: string,
): TsirError {
  return new TsirError(
    'STO_UNSUPPORTED_OPERATION',
    `disk "${disk}" (driver "${driver}") does not support ${operation}: ${detail}`,
    {
      kind: KIND,
      hint: 'check `disk.capabilities` before calling — every false capability is a build-time fact, not a warning',
      context: { disk, driver, operation },
    },
  );
}

/** `put({ ifNoneMatch: true })` against a key that exists. */
export function alreadyExists(key: string, disk: string): TsirError {
  return new TsirError('STO_ALREADY_EXISTS', `key "${key}" already exists on disk "${disk}"`, {
    kind: KIND,
    hint: 'the caller asked for `ifNoneMatch`; use `head` first, or `put` without it to replace',
    context: { disk, key },
  });
}

/** A `memory` disk (or any ephemeral one) as the default in production. */
export function forbiddenInProduction(disk: string, driver: string): TsirError {
  return new TsirError(
    'STO_FORBIDDEN_IN_PRODUCTION',
    `disk "${disk}" uses the "${driver}" driver, which does not survive the process — refused in production`,
    {
      kind: KIND,
      hint: 'point the disk at `s3` (R2 by endpoint) or `local`, or set the disk for development only',
      context: { disk, driver },
    },
  );
}

/** `local` on a runtime with no filesystem: a Worker, a browser, an edge isolate. */
export function filesystemUnavailable(disk: string): TsirError {
  return new TsirError(
    'STO_FILESYSTEM_UNAVAILABLE',
    `disk "${disk}" uses the "local" driver, and this runtime has no filesystem`,
    {
      kind: KIND,
      hint: 'use the `s3` driver (R2 by endpoint) on Workers and Lambda — a `local` disk is for dev and for a Bun/Node process',
      context: { disk },
    },
  );
}

/** A `storage.disks` entry that cannot be built: a missing env var, a required setting absent. */
export function configInvalid(disk: string, reason: string, hint: string): TsirError {
  return new TsirError('STO_CONFIG_INVALID', `storage disk "${disk}" is not usable: ${reason}`, {
    kind: KIND,
    hint,
    context: { disk },
  });
}

export function signingFailed(reason: string): TsirError {
  return new TsirError('STO_SIGNING_FAILED', `could not sign the request: ${reason}`, {
    kind: KIND,
    hint: 'check `storage.disks.<name>.credentials` — the secret key is the only thing that can cause this',
    context: {},
  });
}

/** A non-2xx answer from the storage backend, with the status and the backend's own message. */
export function requestFailed(input: {
  readonly disk: string;
  readonly operation: string;
  readonly status: number;
  readonly body?: string | undefined;
}): TsirError {
  const detail =
    input.body === undefined || input.body === '' ? '' : `: ${input.body.slice(0, 300)}`;
  return new TsirError(
    'STO_REQUEST_FAILED',
    `${input.operation} on disk "${input.disk}" answered ${String(input.status)}${detail}`,
    {
      kind: KIND,
      hint:
        input.status === 403
          ? 'a 403 from S3/R2 is usually the credentials or the bucket policy, not the key'
          : 'the backend answered non-2xx; the body above is its own message',
      context: { disk: input.disk, status: input.status },
    },
  );
}

/** An operation on a key that does not exist (copy/move source, setVisibility). */
export function notFound(key: string, disk: string): TsirError {
  return new TsirError('STO_NOT_FOUND', `no object at ${JSON.stringify(key)} on disk "${disk}"`, {
    kind: KIND,
    hint: 'call `head` or `exists` first — copy/move/setVisibility need the source to be present',
    context: { disk, key },
  });
}
