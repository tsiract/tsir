/**
 * @tsir/storage — named object-storage disks over one port.
 *
 * ```ts
 * import { disksFromConfig } from '@tsir/storage';
 *
 * const disks = disksFromConfig({ storage: config.storage, env: process.env, production });
 * await disks.disk('assets').put('logo.png', bytes, { contentType: 'image/png' });
 * ```
 *
 * Bytes in, bytes out, and a URL that says whether it is public or signed. Three drivers —
 * `memory`, `local`, `s3` — and R2 is the third of those by endpoint, not a fourth driver.
 */

/* ── the port ─────────────────────────────────────────────────────────────── */
export { utf8, text } from './port.ts';
export type {
  Disk,
  DiskCapabilities,
  GetOptions,
  ListOptions,
  ListResult,
  PutOptions,
  StorageDriver,
  StoredBody,
  StoredObject,
  Visibility,
} from './port.ts';

/* ── the disk wrapper and the registry ────────────────────────────────────── */
export { assertKey, assertDurable, createDisk, MAX_KEY_BYTES } from './disk.ts';
export {
  createDisks,
  defineDisk,
  type CreateDisksOptions,
  type DiskDefinition,
  type Disks,
} from './disks.ts';

/* ── drivers ──────────────────────────────────────────────────────────────── */
export { memoryDriver } from './drivers/memory.ts';
export { localDriver, type LocalDriverOptions } from './drivers/adapters/local.ts';
export { s3Driver, type S3DriverOptions } from './drivers/s3.ts';

/* ── configuration ────────────────────────────────────────────────────────── */
export {
  disksFromConfig,
  driverFromConfig,
  STORAGE_DRIVERS,
  type BuildDisksOptions,
  type ConfiguredDisk,
  type EnvRef,
  type StorageDriverName,
} from './config.ts';

/**
 * Signing, for the one caller that needs a URL without a disk in hand — a signed webhook, a
 * presigned upload minted by an API route.
 *
 * The pieces underneath (`hmac`, `signingKey`, `canonicalUri`, `parseListObjectsV2`) stay
 * unexported on purpose: they are how this package builds a request, not what it promises about
 * one, and an XML parser's return shape is not a compatibility obligation worth taking on to
 * serve a third-party driver that does not exist yet. The public API surface is where that
 * argument can be reopened, deliberately, with a `./sigv4` subpath.
 */
export {
  presignUrl,
  signRequest,
  type AwsCredentials,
  type PresignInput,
  type SignRequestInput,
  type SigningContext,
} from './sigv4.ts';

/* ── errors ───────────────────────────────────────────────────────────────── */
export type { StorageErrorCode } from './errors.ts';

/* ── bootstrap ────────────────────────────────────────────────────────────── */
export { createStorageBootstrap } from './bootstrap.ts';
export type { StorageBootstrap, StorageBootstrapOptions } from './bootstrap.ts';
