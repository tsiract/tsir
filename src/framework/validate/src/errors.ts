/**
 * Validation errors (`VLD-*`): a schema the framework cannot use, detected when it is registered.
 *
 * The union is the registry: `bun src/tools/check-error-codes.ts` fails when a code is thrown
 * without being listed here, and when a listed code is removed from the baseline.
 */

export type ValidateErrorCode = 'VLD_INVALID' | 'VLD_NOT_STANDARD_SCHEMA' | 'VLD_ASYNC_SCHEMA';
