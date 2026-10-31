/**
 * HTTP pipeline errors raised while a server is being built (`HTP-*`), before any request is served.
 *
 * The union is the registry: `bun src/tools/check-error-codes.ts` fails when a code is thrown
 * without being listed here, and when a listed code is removed from the baseline.
 */

export type HttpBuildErrorCode =
  | 'HTP_UNKNOWN_GUARD'
  | 'HTP_UNKNOWN_POLICY'
  | 'HTP_CORS_WILDCARD_CREDENTIALS'
  | 'HTP_BAD_HANDLER'
  | 'HTP_MIDDLEWARE_NEXT_TWICE'
  | 'HTP_UNKNOWN_MIDDLEWARE';
