/**
 * Forge (deployment) error codes.
 */
import { TsirError } from '@tsir/container';

export type ForgeErrorCode = 'FORGE_DEPLOY_FAILED';

/** A deployment operation failed. */
export function forgeDeployFailed(
  message: string,
  context?: Record<string, string | number | boolean>,
): TsirError {
  return new TsirError('FORGE_DEPLOY_FAILED', message, {
    kind: 'deploy',
    ...(context !== undefined ? { context } : {}),
  });
}
