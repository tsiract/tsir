# Tasks — `@tsir/servers` (← forge) (Phase 10)

> Server management: server CRUD, command execution, deploy recipes, SSH/local providers, nginx
> site config, database creation (postgres/mysql), and SSL management. Seven of eight features are
> complete. The remaining work is cloud-provider integration so a server can be provisioned on
> Hetzner, DigitalOcean, Vultr, Lightsail, or Linode instead of only by SSH.
>
> **Plan:** [`15-capabilities.md`](../modules/15-capabilities.md) · **Related:**
> [`07-deploy.md`](./07-deploy.md) (deploy graph), [`08-deploy.md`](../modules/08-deploy.md) (plan).

**Status: in progress.** Local + SSH providers, site/DB/SSL management are complete (7/8). One
feature remains: cloud providers.

## Tasks

| ID      | Task                                                    | Status | Depends | Acceptance                                                                                                                                           |
| ------- | ------------------------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SRV-1` | Server CRUD + command execution + deploy recipes        | `[x]`  | —       | `createServer`, `deleteServer`, `runCommand`, `deploy` with recipes; a recipe is a named list of steps with status reporting                         |
| `SRV-2` | `localProvider` + `sshProvider` (ssh CLI)               | `[x]`  | `SRV-1` | `localProvider` runs commands in-process; `sshProvider` shells out to `ssh` with config-driven connection; both implement `ServerProvider`           |
| `SRV-3` | `createSite` / `deleteSite` — nginx config + reload     | `[x]`  | `SRV-1` | Writes an nginx server block, symlinks to sites-enabled, reloads nginx; a failed reload rolls back the config                                        |
| `SRV-4` | `createDatabase` / `deleteDatabase` — postgres + mysql  | `[x]`  | `SRV-1` | Uses `psql`/`mysql` CLI; a duplicate database is a coded error, not a crash                                                                          |
| `SRV-5` | `obtainSslCertificate` / `revokeSslCertificate`         | `[x]`  | `SRV-3` | Certbot wrapper; revocation updates the nginx config; a failed certbot run surfaces the stderr                                                       |
| `SRV-6` | Cloud providers — Hetzner, DO, Vultr, Lightsail, Linode | `[ ]`  | `SRV-1` | App-supplied `CloudProviderLike` per vendor (ADR-0027 client rule); `createServer` provisions a VM and returns an SSH-able server; no SDK dependency |

## Design notes

**Cloud providers are app-supplied clients, not SDKs.** Each vendor gets a `*ProviderLike`
interface (`hetznerProvider`, `digitalOceanProvider`, etc.) whose shape the package names. The app
passes a client (raw `fetch` wrapper or the vendor's SDK), and the provider maps `createServer` to
the vendor's API. This keeps `@tsir/servers` dependency-free — the same rule as `@tsir/cache`'s
Redis driver.

**A cloud-provisioned server returns an SSH-able server.** `SRV-6`'s `createServer` returns a
`Server` whose `connection` is an `sshProvider` config, so the rest of the package (deploy, site,
DB, SSL) works unchanged. The provider is just the provisioning step.

**What the gates check.** `bun test src/framework/forge` covers the local provider, the SSH
provider's config generation, and the site/DB/SSL logic against a fake command runner. `SRV-6` adds
provider tests against fake vendor APIs.
