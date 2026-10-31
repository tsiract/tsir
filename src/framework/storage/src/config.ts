/**
 * `storage.disks` in `tsir.js` (`STOR-10`, `§ 2.2`).
 *
 * The registry already knows how to validate a disk list; this module is the half that knows how
 * to **build** one from configuration, which means three things the runtime registry does not:
 *
 *   · **A driver is named by string**, so an unknown name is a real possibility and gets
 *     `STO_DRIVER_MISSING` listing what this build declares — not a `TypeError` from a lookup.
 *   · **A credential is an environment reference**, `{ fromEnv: 'R2_SECRET_ACCESS_KEY' }`, and it
 *     is resolved here rather than in `tsir.js`. the config rule says no secrets in the
 *     config file, and that rule is only real if the resolver is the thing that reads the env.
 *   · **`local` needs a root and `s3` needs a bucket**, and both are checked at build time with a
 *     message naming the setting — the alternative is a `TypeError` from three layers down on the
 *     first upload.
 */

import { configInvalid, driverMissing } from './errors.ts';
import { localDriver } from './drivers/adapters/local.ts';
import { memoryDriver } from './drivers/memory.ts';
import { s3Driver } from './drivers/s3.ts';
import { createDisks, type Disks } from './disks.ts';
import type { StorageDriver } from './port.ts';

/** The drivers this build knows, by the name a `tsir.js` writes. */
export const STORAGE_DRIVERS = ['memory', 'local', 's3'] as const;

export type StorageDriverName = (typeof STORAGE_DRIVERS)[number];

/** A string, or a reference to one in the environment. */
export type EnvRef = string | { readonly fromEnv: string };

export interface ConfiguredDisk {
  /**
   * The driver name as written in `tsir.js`. Typed as `string`, not `StorageDriverName`: config is
   * user data that reaches the registry at run time, and an unknown name must fail with
   * `STO_DRIVER_MISSING` listing the shipped drivers.
   */
  readonly driver: string;
  /** `local`: the directory that is the disk's root. */
  readonly root?: string | undefined;
  /** `s3`: the bucket. */
  readonly bucket?: string | undefined;
  /** `s3`: `us-east-1`, `auto` for R2. */
  readonly region?: string | undefined;
  /** `s3`: `https://<account>.r2.cloudflarestorage.com`. Omit for AWS. */
  readonly endpoint?: string | undefined;
  /** `s3`: where objects are publicly readable, which is what makes `url()` answer. */
  readonly publicBaseUrl?: string | undefined;
  readonly forcePathStyle?: boolean | undefined;
  readonly credentials?:
    | {
        readonly accessKeyId?: EnvRef | undefined;
        readonly secretAccessKey?: EnvRef | undefined;
        readonly sessionToken?: EnvRef | undefined;
      }
    | undefined;
  readonly temporaryUrlTtlMs?: number | undefined;
  readonly required?: boolean | undefined;
}

export interface BuildDisksOptions {
  readonly storage?:
    | {
        readonly default?: string | undefined;
        readonly disks?: Readonly<Record<string, ConfiguredDisk>> | undefined;
      }
    | undefined;
  /** Where `{ fromEnv }` references are read from. `process.env` in a Bun process. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Injected into the `s3` driver, so a probe can be tested without a bucket. */
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly production?: boolean | undefined;
}

function resolveRef(
  value: EnvRef | undefined,
  env: Readonly<Record<string, string | undefined>>,
  disk: string,
  setting: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;

  const found = env[value.fromEnv];
  if (found === undefined || found === '') {
    throw configInvalid(
      disk,
      `${setting} reads \`${value.fromEnv}\`, which is not set`,
      'add it to `.env` (or the environment) — a secret in `tsir.js` is refused on purpose, and an unset one must fail at boot, not at the first upload',
    );
  }
  return found;
}

/** Turn one configured disk into the driver it names. */
export function driverFromConfig(
  name: string,
  config: ConfiguredDisk,
  options: Pick<BuildDisksOptions, 'env' | 'fetch' | 'now'> = {},
): StorageDriver {
  const env = options.env ?? {};

  if (config.driver === 'memory') return memoryDriver();

  if (config.driver === 'local') {
    if (config.root === undefined || config.root === '') {
      throw configInvalid(
        name,
        'the `local` driver needs a `root`',
        'set `root` to the directory the disk lives in, relative to the project (`storage/app` by default in a generated project)',
      );
    }
    return localDriver({ root: config.root, name });
  }

  if (config.driver === 's3') {
    if (config.bucket === undefined || config.bucket === '') {
      throw configInvalid(
        name,
        'the `s3` driver needs a `bucket`',
        'set `bucket`, and `endpoint` too when it is R2 or any S3-compatible service',
      );
    }
    const accessKeyId = resolveRef(
      config.credentials?.accessKeyId,
      env,
      name,
      'credentials.accessKeyId',
    );
    const secretAccessKey = resolveRef(
      config.credentials?.secretAccessKey,
      env,
      name,
      'credentials.secretAccessKey',
    );
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      throw configInvalid(
        name,
        'the `s3` driver needs credentials',
        'set `credentials.accessKeyId` and `credentials.secretAccessKey` as `{ fromEnv: … }` references — the values never belong in `tsir.js`',
      );
    }
    const sessionToken = resolveRef(
      config.credentials?.sessionToken,
      env,
      name,
      'credentials.sessionToken',
    );
    return s3Driver({
      bucket: config.bucket,
      region: config.region ?? 'auto',
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken === undefined ? {} : { sessionToken }),
      },
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.publicBaseUrl }),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
      name,
    });
  }

  throw driverMissing(config.driver, name, STORAGE_DRIVERS);
}

/**
 * Build the registry from `tsir.js`.
 *
 * A project with no `storage` block gets a `memory` default, which is what makes
 * `tsir storage:probe` runnable in a fresh project — and what `production: true` refuses, loudly,
 * because a disk that forgets is not a disk.
 */
export function disksFromConfig(options: BuildDisksOptions = {}): Disks {
  const declared = options.storage?.disks;
  if (declared === undefined || Object.keys(declared).length === 0) {
    return createDisks({
      disks: { default: { driver: memoryDriver() } },
      default: 'default',
      ...(options.production === undefined ? {} : { production: options.production }),
    });
  }

  const disks: Record<
    string,
    { driver: StorageDriver; temporaryUrlTtlMs?: number; required?: boolean }
  > = {};
  for (const [name, config] of Object.entries(declared)) {
    disks[name] = {
      driver: driverFromConfig(name, config, options),
      ...(config.temporaryUrlTtlMs === undefined
        ? {}
        : { temporaryUrlTtlMs: config.temporaryUrlTtlMs }),
      ...(config.required === undefined ? {} : { required: config.required }),
    };
  }

  return createDisks({
    disks,
    ...(options.storage?.default === undefined ? {} : { default: options.storage.default }),
    ...(options.production === undefined ? {} : { production: options.production }),
  });
}
