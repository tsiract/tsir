/**
 * Storage disk registry.
 *
 * `@tsir/storage` builds named disks from `config/storage.ts`. The default
 * disk is `memory` so uploads work in tests and local dev without S3; a `local`
 * disk is available for development uploads.
 *
 * Disks are named: a request can only write to a disk declared here. The
 * `disks` object exposes `get(name)` (or `get()` for the default) and
 * `require(name)` for disks that must exist.
 */
import { createStorageBootstrap } from '@tsir/storage';
import { isProduction } from '@tsir/core';
import appConfig from '../../../config/storage.ts';

export const { disks, disksToken, disksProvider } = createStorageBootstrap({
  storage: appConfig,
  // `CAP-007`: a `memory` disk on a Worker is an upload that survives until the isolate does.
  production: isProduction(),
});
