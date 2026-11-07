/**
 * CLI errors (`CLI-*`): input the command cannot act on, reported with a stable code.
 *
 * The union is the registry: `bun src/tools/check-error-codes.ts` fails when a code is thrown
 * without being listed here, and when a listed code is removed from the baseline.
 */

export type ConsoleErrorCode = 'CLI_WSDL_INVALID' | 'CLI_STUB_MISSING_VAR';
