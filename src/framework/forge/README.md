# `@tsir/forge`

Server management over a single `ServerProvider` port: list/create/destroy
servers and run commands on them. Two providers ship in the box — `localProvider`
(runs commands with `child_process`) and `sshProvider` (runs them over the `ssh`
CLI).

Higher-level operations — site (nginx), database, and SSL (certbot) management —
are built on `provider.run()`, so they work against any provider.

## Providers

| Provider                                  | When to use                            |
| ----------------------------------------- | -------------------------------------- |
| `localProvider()`                         | Local dev; commands run on the host.   |
| `sshProvider({ host, user, privateKey })` | Remote servers; commands run over SSH. |

## Site management

`createSite` writes an nginx config (reverse proxy or static root), symlinks it
into `sites-enabled`, tests, and reloads. `deleteSite` removes it.

```ts
await createSite(provider, server.id, {
  domain: 'app.example.com',
  root: '/var/www/app',
  proxyPort: 3000,
});
await deleteSite(provider, server.id, 'app.example.com');
```

## Database management

`createDatabase` / `deleteDatabase` run the engine's CLI tools (`psql` for
Postgres, `mysql` for MySQL) over `provider.run()`.

```ts
await createDatabase(provider, server.id, {
  engine: 'postgres',
  name: 'appdb',
  user: 'appuser',
  password: 'secret',
});
```

## SSL

`obtainSslCertificate` runs certbot in nginx mode; `revokeSslCertificate`
revokes and removes the certificate.

```ts
await obtainSslCertificate(provider, server.id, {
  domain: 'app.example.com',
  email: 'ops@example.com',
});
```
