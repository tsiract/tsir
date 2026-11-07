/**
 * @tsir/forge — server management (Forge equivalent).
 *
 * A `ServerProvider` manages servers: create, list, destroy, and run commands.
 * The `sshProvider` runs commands over SSH; the `localProvider` runs commands
 * on the local machine (for dev).
 *
 * Deployment: `deploy()` runs a sequence of commands on a server (git pull,
 * install deps, build, restart).
 *
 * Higher-level operations — site, database, and SSL management — are built on
 * `provider.run()` so they work against any provider.
 */

import { forgeDeployFailed } from './errors.ts';

export interface Server {
  id: string;
  name: string;
  ip: string;
  status: 'active' | 'provisioning' | 'failed';
}

export interface ServerProvider {
  list(): Promise<Server[]>;
  create(name: string): Promise<Server>;
  destroy(id: string): Promise<void>;
  run(
    serverId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface DeployStep {
  name: string;
  command: string;
}

export interface DeployRecipe {
  steps: readonly DeployStep[];
}

/**
 * Run a deploy recipe on a server. Returns the results of each step.
 * Throws on the first non-zero exit code.
 */
export async function deploy(
  provider: ServerProvider,
  serverId: string,
  recipe: DeployRecipe,
): Promise<Array<{ step: string; output: string }>> {
  const results: Array<{ step: string; output: string }> = [];
  for (const step of recipe.steps) {
    const result = await provider.run(serverId, step.command);
    if (result.exitCode !== 0) {
      throw forgeDeployFailed(`Deploy step "${step.name}" failed: ${result.stderr}`, {
        step: step.name,
      });
    }
    results.push({ step: step.name, output: result.stdout });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Site (nginx) management
// ---------------------------------------------------------------------------

export interface SiteConfig {
  /** Server name (domain), e.g. "app.example.com". */
  domain: string;
  /** Root directory the site serves from. */
  root: string;
  /** Upstream port for a reverse proxy, if any. */
  proxyPort?: number;
  /** Extra server-block directives, appended verbatim. */
  extra?: string;
}

/** Write an nginx site config and enable it. Works against any provider. */
export async function createSite(
  provider: ServerProvider,
  serverId: string,
  site: SiteConfig,
): Promise<void> {
  const upstream = site.proxyPort
    ? `    location / {\n        proxy_pass http://127.0.0.1:${site.proxyPort};\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n    }`
    : `    root ${site.root};\n    index index.html index.htm;`;
  const config = `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${site.domain};\n${upstream}\n${site.extra ?? ''}\n}\n`;
  const cmd =
    `cat > /etc/nginx/sites-available/${site.domain} << 'EOF'\n${config}\nEOF\n` +
    `ln -sf /etc/nginx/sites-available/${site.domain} /etc/nginx/sites-enabled/${site.domain}\n` +
    `nginx -t && systemctl reload nginx`;
  const result = await provider.run(serverId, cmd);
  if (result.exitCode !== 0) {
    throw forgeDeployFailed(`Failed to create site ${site.domain}: ${result.stderr}`, {
      step: 'create-site',
    });
  }
}

/** Remove a site's config and reload nginx. */
export async function deleteSite(
  provider: ServerProvider,
  serverId: string,
  domain: string,
): Promise<void> {
  const cmd =
    `rm -f /etc/nginx/sites-enabled/${domain} /etc/nginx/sites-available/${domain}\n` +
    `nginx -t && systemctl reload nginx`;
  const result = await provider.run(serverId, cmd);
  if (result.exitCode !== 0) {
    throw forgeDeployFailed(`Failed to delete site ${domain}: ${result.stderr}`, {
      step: 'delete-site',
    });
  }
}

// ---------------------------------------------------------------------------
// Database management
// ---------------------------------------------------------------------------

export type DatabaseEngine = 'postgres' | 'mysql';

export interface DatabaseSpec {
  engine: DatabaseEngine;
  name: string;
  user: string;
  password: string;
}

/** Create a database and an owning user. Runs the engine's CLI tools over `run()`. */
export async function createDatabase(
  provider: ServerProvider,
  serverId: string,
  spec: DatabaseSpec,
): Promise<void> {
  let cmd: string;
  if (spec.engine === 'postgres') {
    cmd =
      `sudo -u postgres psql -c "CREATE USER ${spec.user} WITH PASSWORD '${spec.password}';"\n` +
      `sudo -u postgres psql -c "CREATE DATABASE ${spec.name} OWNER ${spec.user};"`;
  } else {
    cmd =
      `mysql -e "CREATE USER '${spec.user}'@'localhost' IDENTIFIED BY '${spec.password}';"\n` +
      `mysql -e "CREATE DATABASE ${spec.name};"\n` +
      `mysql -e "GRANT ALL PRIVILEGES ON ${spec.name}.* TO '${spec.user}'@'localhost'; FLUSH PRIVILEGES;"`;
  }
  const result = await provider.run(serverId, cmd);
  if (result.exitCode !== 0) {
    throw forgeDeployFailed(`Failed to create database ${spec.name}: ${result.stderr}`, {
      step: 'create-database',
    });
  }
}

/** Drop a database and its user. */
export async function deleteDatabase(
  provider: ServerProvider,
  serverId: string,
  spec: DatabaseSpec,
): Promise<void> {
  let cmd: string;
  if (spec.engine === 'postgres') {
    cmd =
      `sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${spec.name};"\n` +
      `sudo -u postgres psql -c "DROP USER IF EXISTS ${spec.user};"`;
  } else {
    cmd =
      `mysql -e "DROP DATABASE IF EXISTS ${spec.name};"\n` +
      `mysql -e "DROP USER IF EXISTS '${spec.user}'@'localhost';"`;
  }
  const result = await provider.run(serverId, cmd);
  if (result.exitCode !== 0) {
    throw forgeDeployFailed(`Failed to delete database ${spec.name}: ${result.stderr}`, {
      step: 'delete-database',
    });
  }
}

// ---------------------------------------------------------------------------
// SSL (certbot) management
// ---------------------------------------------------------------------------

export interface SslSpec {
  domain: string;
  /** Email for Let's Encrypt registration. */
  email: string;
}

/** Obtain and install an SSL certificate via certbot. */
export async function obtainSslCertificate(
  provider: ServerProvider,
  serverId: string,
  spec: SslSpec,
): Promise<void> {
  const cmd = `certbot --nginx -d ${spec.domain} --non-interactive --agree-tos -m ${spec.email} --redirect`;
  const result = await provider.run(serverId, cmd);
  if (result.exitCode !== 0) {
    throw forgeDeployFailed(
      `Failed to obtain SSL certificate for ${spec.domain}: ${result.stderr}`,
      { step: 'obtain-ssl' },
    );
  }
}

/** Revoke and remove an SSL certificate. */
export async function revokeSslCertificate(
  provider: ServerProvider,
  serverId: string,
  domain: string,
): Promise<void> {
  const cmd =
    `certbot revoke --cert-name ${domain} --non-interactive\n` +
    `certbot delete --cert-name ${domain} --non-interactive`;
  const result = await provider.run(serverId, cmd);
  if (result.exitCode !== 0) {
    throw forgeDeployFailed(`Failed to revoke SSL certificate for ${domain}: ${result.stderr}`, {
      step: 'revoke-ssl',
    });
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** A local provider that runs commands via `child_process`. */
export function localProvider(): ServerProvider {
  const servers = new Map<string, Server>();

  return {
    async list() {
      return [...servers.values()];
    },
    async create(name) {
      const server: Server = { id: `srv_${Date.now()}`, name, ip: '127.0.0.1', status: 'active' };
      servers.set(server.id, server);
      return server;
    },
    async destroy(id) {
      servers.delete(id);
    },
    async run(_id, command) {
      const { execSync } = await import('node:child_process');
      try {
        const stdout = execSync(command, { encoding: 'utf-8' });
        return { stdout, stderr: '', exitCode: 0 };
      } catch (e) {
        const err = e as { stderr?: string; status?: number };
        return { stdout: '', stderr: err.stderr ?? String(e), exitCode: err.status ?? 1 };
      }
    },
  };
}

/** Options for the SSH provider. */
export interface SshProviderOptions {
  /** Host to connect to. */
  host: string;
  /** SSH user. Default: "root". */
  user?: string;
  /** Path to a private key file, or the key contents. */
  privateKey?: string;
  /** SSH port. Default: 22. */
  port?: number;
  /** Strict host key checking. Default: false. */
  strictHostKeyChecking?: boolean;
}

/**
 * SSH provider — runs commands on a remote server via the `ssh` CLI.
 *
 * The server list is in-memory (cloud provisioning is out of scope); the
 * value here is remote command execution over SSH, which `localProvider`
 * cannot do.
 */
export function sshProvider(options: SshProviderOptions): ServerProvider {
  const servers = new Map<string, Server>();
  const user = options.user ?? 'root';
  const port = options.port ?? 22;
  const strict = options.strictHostKeyChecking ?? false;

  const sshArgs = [
    '-o',
    `StrictHostKeyChecking=${strict ? 'yes' : 'no'}`,
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-p',
    String(port),
  ];
  if (options.privateKey) {
    sshArgs.push('-i', options.privateKey);
  }

  return {
    async list() {
      return [...servers.values()];
    },
    async create(name) {
      const server: Server = { id: `srv_${Date.now()}`, name, ip: options.host, status: 'active' };
      servers.set(server.id, server);
      return server;
    },
    async destroy(id) {
      servers.delete(id);
    },
    async run(_id, command) {
      const { execFileSync } = await import('node:child_process');
      try {
        const stdout = execFileSync('ssh', [...sshArgs, `${user}@${options.host}`, command], {
          encoding: 'utf-8',
        });
        return { stdout, stderr: '', exitCode: 0 };
      } catch (e) {
        const err = e as { stderr?: string; status?: number };
        return { stdout: '', stderr: err.stderr ?? String(e), exitCode: err.status ?? 1 };
      }
    },
  };
}
