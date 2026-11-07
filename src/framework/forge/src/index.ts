/**
 * @tsir/forge — server management.
 *
 * ```ts
 * import { createForgeBootstrap, localProvider, deploy } from '@tsir/forge';
 *
 * const { provider } = createForgeBootstrap({ provider: localProvider() });
 * const server = await provider.create('web-1');
 * await deploy(provider, server.id, {
 *   steps: [
 *     { name: 'pull', command: 'git pull' },
 *     { name: 'install', command: 'bun install' },
 *     { name: 'build', command: 'bun run build' },
 *   ],
 * });
 * ```
 */

export {
  createDatabase,
  createSite,
  deleteDatabase,
  deleteSite,
  deploy,
  localProvider,
  obtainSslCertificate,
  revokeSslCertificate,
  sshProvider,
  type DatabaseEngine,
  type DatabaseSpec,
  type DeployRecipe,
  type DeployStep,
  type Server,
  type ServerProvider,
  type SiteConfig,
  type SshProviderOptions,
  type SslSpec,
} from './forge.ts';

export { createForgeBootstrap } from './bootstrap.ts';
export type { ForgeBootstrap, ForgeBootstrapOptions } from './bootstrap.ts';
