import { describe, expect, test } from 'bun:test';
import {
  createDatabase,
  createSite,
  deleteDatabase,
  deleteSite,
  localProvider,
  obtainSslCertificate,
  revokeSslCertificate,
  sshProvider,
  type ServerProvider,
} from './index.ts';

/** A provider that records the last command run and returns a configurable result. */
function mockProvider(result: { stdout?: string; stderr?: string; exitCode?: number } = {}) {
  const runs: string[] = [];
  const provider: ServerProvider = {
    list: async () => [],
    create: async (name) => ({ id: 'srv_1', name, ip: '10.0.0.1', status: 'active' }),
    destroy: async () => {},
    run: async (_id, command) => {
      runs.push(command);
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
      };
    },
  };
  return { provider, runs };
}

describe('forge site management', () => {
  test('createSite writes a proxy config and reloads nginx', async () => {
    const { provider, runs } = mockProvider();
    await createSite(provider, 'srv_1', {
      domain: 'app.example.com',
      root: '/var/www/app',
      proxyPort: 3000,
    });
    const cmd = runs[0]!;
    expect(cmd).toContain('server_name app.example.com');
    expect(cmd).toContain('proxy_pass http://127.0.0.1:3000');
    expect(cmd).toContain('/etc/nginx/sites-available/app.example.com');
    expect(cmd).toContain('nginx -t && systemctl reload nginx');
  });

  test('createSite with no proxy port uses root + index', async () => {
    const { provider, runs } = mockProvider();
    await createSite(provider, 'srv_1', {
      domain: 'static.example.com',
      root: '/var/www/static',
    });
    const cmd = runs[0]!;
    expect(cmd).toContain('root /var/www/static');
    expect(cmd).toContain('index index.html index.htm');
  });

  test('createSite throws on non-zero exit', async () => {
    const { provider } = mockProvider({ exitCode: 1, stderr: 'nginx: bad config' });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      createSite(provider, 'srv_1', { domain: 'x.example.com', root: '/var/www/x' }),
    ).rejects.toThrow(/Failed to create site/);
  });

  test('deleteSite removes config and reloads', async () => {
    const { provider, runs } = mockProvider();
    await deleteSite(provider, 'srv_1', 'app.example.com');
    const cmd = runs[0]!;
    expect(cmd).toContain('rm -f /etc/nginx/sites-enabled/app.example.com');
    expect(cmd).toContain('nginx -t && systemctl reload nginx');
  });
});

describe('forge database management', () => {
  test('createDatabase for postgres runs psql commands', async () => {
    const { provider, runs } = mockProvider();
    await createDatabase(provider, 'srv_1', {
      engine: 'postgres',
      name: 'appdb',
      user: 'appuser',
      password: 'secret',
    });
    const cmd = runs[0]!;
    expect(cmd).toContain("CREATE USER appuser WITH PASSWORD 'secret'");
    expect(cmd).toContain('CREATE DATABASE appdb OWNER appuser');
  });

  test('createDatabase for mysql runs mysql commands', async () => {
    const { provider, runs } = mockProvider();
    await createDatabase(provider, 'srv_1', {
      engine: 'mysql',
      name: 'appdb',
      user: 'appuser',
      password: 'secret',
    });
    const cmd = runs[0]!;
    expect(cmd).toContain("CREATE USER 'appuser'@'localhost'");
    expect(cmd).toContain('CREATE DATABASE appdb');
    expect(cmd).toContain('GRANT ALL PRIVILEGES');
  });

  test('deleteDatabase drops database and user', async () => {
    const { provider, runs } = mockProvider();
    await deleteDatabase(provider, 'srv_1', {
      engine: 'postgres',
      name: 'appdb',
      user: 'appuser',
      password: 'secret',
    });
    const cmd = runs[0]!;
    expect(cmd).toContain('DROP DATABASE IF EXISTS appdb');
    expect(cmd).toContain('DROP USER IF EXISTS appuser');
  });

  test('createDatabase throws on failure', async () => {
    const { provider } = mockProvider({ exitCode: 1, stderr: 'role exists' });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      createDatabase(provider, 'srv_1', {
        engine: 'postgres',
        name: 'db',
        user: 'u',
        password: 'p',
      }),
    ).rejects.toThrow(/Failed to create database/);
  });
});

describe('forge SSL management', () => {
  test('obtainSslCertificate runs certbot', async () => {
    const { provider, runs } = mockProvider();
    await obtainSslCertificate(provider, 'srv_1', {
      domain: 'app.example.com',
      email: 'ops@example.com',
    });
    const cmd = runs[0]!;
    expect(cmd).toContain('certbot --nginx -d app.example.com');
    expect(cmd).toContain('--agree-tos -m ops@example.com --redirect');
  });

  test('revokeSslCertificate revokes and deletes', async () => {
    const { provider, runs } = mockProvider();
    await revokeSslCertificate(provider, 'srv_1', 'app.example.com');
    const cmd = runs[0]!;
    expect(cmd).toContain('certbot revoke --cert-name app.example.com');
    expect(cmd).toContain('certbot delete --cert-name app.example.com');
  });

  test('obtainSslCertificate throws on failure', async () => {
    const { provider } = mockProvider({ exitCode: 1, stderr: 'certbot error' });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      obtainSslCertificate(provider, 'srv_1', {
        domain: 'app.example.com',
        email: 'ops@example.com',
      }),
    ).rejects.toThrow(/Failed to obtain SSL certificate/);
  });
});

describe('forge ssh provider', () => {
  test('sshProvider creates a server with the configured host', async () => {
    const p = sshProvider({ host: '10.0.0.1', user: 'deploy', port: 2222 });
    const s = await p.create('web-1');
    expect(s.ip).toBe('10.0.0.1');
    expect(s.status).toBe('active');
  });

  test('sshProvider run returns a failure result (no real server in tests)', async () => {
    const p = sshProvider({ host: '127.0.0.1', port: 1 });
    const s = await p.create('web-1');
    // Port 1 is unlikely to have an SSH server; run should return non-zero quickly.
    const result = await p.run(s.id, 'echo hi');
    expect(result.exitCode).not.toBe(0);
  });

  test('localProvider still works alongside new functions', async () => {
    const p = localProvider();
    const s = await p.create('web-1');
    const r = await p.run(s.id, 'echo hello');
    expect(r.stdout.trim()).toBe('hello');
  });
});
