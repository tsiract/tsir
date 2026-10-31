/**
 * Application-level errors raised by `@tsir/core` (`APP-*`).
 *
 * The union is the registry: `bun src/tools/check-error-codes.ts` fails when a code is thrown
 * without being listed here, and when a listed code is removed from the baseline.
 */

export type CoreErrorCode =
  | 'APP_CAPABILITY_MISSING'
  | 'APP_ILLEGAL_TRANSITION'
  | 'APP_SHUTDOWN_TIMEOUT'
  | 'APP_SHUTDOWN_INCOMPLETE'
  | 'APP_BOOT_ABORTED'
  | 'APP_HOOK_FAILED'
  | 'APP_MODULES_INVALID'
  | 'APP_MANIFEST_MISSING'
  | 'APP_MANIFEST_STALE'
  | 'APP_BOOTSTRAP_FAILED';
