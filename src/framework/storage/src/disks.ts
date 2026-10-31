/**
 * The registry (`CAP-001`, `CAP-002`, `§ 2.2`).
 *
 * `storage.disks` is the same shape as `cache.stores` and `queue.connections` on purpose: one
 * named registry per port, an explicit `default`, and a name that was never declared is an error
 * rather than a fallback. A user upload that quietly lands on the wrong disk is a data-loss bug
 * that looks like a successful request.
 *
 * Two decisions worth stating:
 *
 *   · **Capabilities are validated at boot; nothing is opened.** A disk's capabilities are static
 *     facts about the driver, so the production check needs no network. The driver instance is
 *     built when the registry is built, which costs nothing either — `s3` holds no socket.
 *   · **`memory` as the default is refused in production**, and so is any disk declared
 *     `required`. A disk that forgets on restart is a cache, and the framework already has one.
 */

import { noDisks, unknownDefault, unknownDisk } from './errors.ts';
import { assertDurable, createDisk } from './disk.ts';
import type { Disk, StorageDriver } from './port.ts';

/** One entry of `storage.disks`. */
export interface DiskDefinition {
  readonly driver: StorageDriver;
  /** Default lifetime for `temporaryUrl`. One hour when unset. */
  readonly temporaryUrlTtlMs?: number | undefined;
  /**
   * Boot-validated, and refused in production if the driver is not durable. Set it on the disk a
   * `requires` block names — an upload that must survive a deploy cannot be on `memory`.
   */
  readonly required?: boolean | undefined;
}

export function defineDisk(definition: DiskDefinition): DiskDefinition {
  return definition;
}

export interface CreateDisksOptions {
  readonly disks: Readonly<Record<string, DiskDefinition>>;
  /** Defaults to `default`, which is what `tsir.js` writes. */
  readonly default?: string | undefined;
  /** Refuse an ephemeral default, and every `required` disk that is ephemeral. */
  readonly production?: boolean | undefined;
}

export interface Disks {
  /** The declared disk names, in declaration order. */
  readonly names: readonly string[];
  readonly default: string;
  /** A disk by name, or the default. An undeclared name is `STO_UNKNOWN_DISK`. */
  disk(name?: string): Disk;
  /** Every declared disk, opened. For `tsir storage:probe --all`. */
  all(): readonly Disk[];
}

export function createDisks(options: CreateDisksOptions): Disks {
  const entries = Object.entries(options.disks);
  if (entries.length === 0) throw noDisks();

  const names = entries.map(([name]) => name);
  const defaultName = options.default ?? 'default';
  if (!names.includes(defaultName)) throw unknownDefault(defaultName, names);

  const disks = new Map<string, Disk>();
  for (const [name, definition] of entries) {
    const disk = createDisk({
      name,
      driver: definition.driver,
      ...(definition.temporaryUrlTtlMs === undefined
        ? {}
        : { temporaryUrlTtlMs: definition.temporaryUrlTtlMs }),
    });
    if (options.production === true && (name === defaultName || definition.required === true)) {
      assertDurable(disk);
    }
    disks.set(name, disk);
  }

  const resolve = (name?: string): Disk => {
    const wanted = name ?? defaultName;
    const disk = disks.get(wanted);
    if (disk === undefined) throw unknownDisk(wanted, names);
    return disk;
  };

  return {
    names,
    default: defaultName,
    disk: resolve,
    all: () => entries.map(([name]) => resolve(name)),
  };
}
