# Cloud & VPS Compatibility Plan

## Goal

Every `@tsir/*` package must run against **Cloudflare**, **AWS**, and a growing
list of **VPS providers**. Cloud-native (serverless) deployments are the
primary target, but the framework must also self-host on commodity VPSes so
teams are not locked into a single cloud.

This doc tracks:

1. Current Cloudflare + AWS compatibility per package.
2. The plan to extend each service to VPS providers (Hetzner, DigitalOcean,
   Vultr, Amazon Lightsail, Linode).

## Cloud provider targets

### Tier 1 — already the default for most packages

- **Cloudflare** — Workers, D1, KV, R2, Queues, Images, Stream, SES-equivalent mail, Pub/Sub.
- **AWS** — Lambda, RDS/Postgres, ElastiCache (Redis), S3, SQS, SES, Secrets Manager, CloudWatch.

### Tier 2 — VPS providers (self-hosted equivalents)

All VPS targets run a Linux distro with Docker/systemd. Tsir deploys a single
binary/process per unit (HTTP, queue worker, scheduler) plus managed services
(Postgres, Redis, object storage) when available.

| Provider             | Compute           | Managed Postgres | Managed Redis | Object Storage             | Notes                                                        |
| -------------------- | ----------------- | ---------------- | ------------- | -------------------------- | ------------------------------------------------------------ |
| **Hetzner**          | Cloud servers     | (self-host)      | (self-host)   | (self-host / S3-compat)    | Low-cost EU VPS; S3-compatible via MinIO or backblaze.       |
| **DigitalOcean**     | Droplets          | Managed Postgres | Managed Redis | Spaces (S3-compat)         | Spaces is S3-compatible; DO Spaces works with the S3 driver. |
| **Vultr**            | Compute Instances | Managed Postgres | Managed Redis | Object Storage (S3-compat) | S3-compatible object storage.                                |
| **Amazon Lightsail** | VPS instances     | Managed Postgres | (self-host)   | (Lightsail buckets / S3)   | AWS-flavored VPS; S3-compatible buckets.                     |
| **Linode** (Akamai)  | Linodes           | Managed Postgres | Managed Redis | Object Storage (S3-compat) | S3-compatible object storage.                                |

**Key insight**: all five VPS providers expose an **S3-compatible object
store** (or allow MinIO). The existing `s3Driver` already covers storage. The
work for VPS support is concentrated in **database**, **queue**, **cache**,
**deploy**, and **media** adapters.

---

## Current Cloudflare + AWS compatibility matrix

Legend: ✅ shipped · 🟡 partial · ❌ not yet

| Package            | Cloudflare                  | AWS                            | Notes                                                          |
| ------------------ | --------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `@tsir/database`   | ✅ D1 + Hyperdrive          | 🟡 Postgres (self-managed/RDS) | Postgres driver works on RDS; no RDS Data API driver yet.      |
| `@tsir/cache`      | ✅ KV + Memory + DB         | ✅ Redis (ElastiCache)         | Redis driver works on ElastiCache; no DynamoDB driver.         |
| `@tsir/storage`    | ✅ R2 (via S3 driver)       | ✅ S3                          | Both via the same `s3Driver` (endpoint-aware).                 |
| `@tsir/queue`      | ✅ Cloudflare Queues        | ✅ SQS                         | Also memory/database/sync drivers for VPS.                     |
| `@tsir/mail`       | ✅ Cloudflare mail          | ✅ SES                         | SMTP + HTTP + Postmark + Resend also work on VPS.              |
| `@tsir/deploy`     | ✅ Workers (wrangler)       | ✅ Lambda (SAM)                | No VPS deploy target yet (Docker/systemd).                     |
| `@tsir/broadcast`  | 🟡 Memory + WebSocket       | 🟡 Memory + WebSocket          | No Durable Objects or Redis pub/sub driver yet.                |
| `@tsir/scout`      | ✅ SQLite (D1)              | ✅ Postgres (RDS)              | No OpenSearch/Cloudflare Vectorize driver yet.                 |
| `@tsir/media`      | ✅ Cloudflare Images/Stream | 🟡 sharp/ffmpeg (self-host)    | sharp + ffmpeg run on VPS; no AWS MediaConvert.                |
| `@tsir/vault`      | 🟡 local keys               | 🟡 local keys                  | No AWS KMS or Cloudflare KMS provider yet.                     |
| `@tsir/pulse`      | ✅ HTTP exporters           | ✅ HTTP exporters              | Works anywhere; no CloudWatch/Logpush native exporter.         |
| `@tsir/notify`     | ✅ (via mail/webhook)       | ✅ (via mail/webhook)          | Works anywhere; no SNS/PubNub native channel.                  |
| `@tsir/telemetry`  | ✅ (D1)                     | ✅ (RDS/SQLite)                | Schema is DB-agnostic.                                         |
| `@tsir/auth`       | ✅ (cookie + DB)            | ✅ (cookie + DB)               | Works anywhere.                                                |
| `@tsir/policy`     | ✅                          | ✅                             | DB-agnostic.                                                   |
| `@tsir/socialize`  | ✅                          | ✅                             | OAuth is HTTP-only; works anywhere.                            |
| `@tsir/cashier`    | ✅                          | ✅                             | Stripe is HTTP-only; works anywhere.                           |
| `@tsir/forge`      | ✅ (local)                  | ✅ (local)                     | `localProvider` shipped; SSH + per-provider APIs planned (P2). |
| `@tsir/nightwatch` | ✅                          | ✅                             | Playwright/in-memory; works anywhere.                          |

---

## VPS extension plan

### P0 — make self-hosted deployments first-class (all VPS providers)

| Package          | Work                                                                                                                                                                                 | Targets                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `@tsir/deploy`   | Add a **`vps` target** that emits a `docker-compose.yml` or systemd unit files + an `nginx`/Caddy reverse proxy config. Reuse the unit graph; each unit becomes a container/service. | Hetzner, DO, Vultr, Lightsail, Linode |
| `@tsir/database` | Verify Postgres driver against managed Postgres offerings (DO, Vultr, Linode, Lightsail). Add a connection string preset per provider.                                               | All VPS                               |
| `@tsir/cache`    | Verify Redis driver against managed Redis (DO, Vultr, Linode). Add TLS support docs.                                                                                                 | All VPS                               |
| `@tsir/queue`    | **Verify database driver** is the default VPS queue (it already works). Document SQS as the managed alternative on Lightsail/AWS.                                                    | All VPS                               |
| `@tsir/storage`  | Document S3-compatible endpoint config for DO Spaces, Vultr Object Storage, Linode Object Storage, Lightsail buckets, and Hetzner-compatible MinIO.                                  | All VPS                               |
| `@tsir/media`    | Document sharp + ffmpeg self-host setup (already works). Add a `minio`-compatible storage note for media output.                                                                     | All VPS                               |

### P1 — native provider SDKs (where they add value)

| Package           | Work                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `@tsir/vault`     | Add `awsKmsProvider()` (AWS KMS) and a Cloudflare KMS/Secrets provider.      |
| `@tsir/cache`     | Add `dynamoDbDriver()` for AWS (serverless cache without ElastiCache).       |
| `@tsir/broadcast` | Add `redisBroadcaster()` for cross-process pub/sub on VPS + ElastiCache.     |
| `@tsir/pulse`     | Add CloudWatch exporter (AWS) and Logpush/cloudflared exporter (Cloudflare). |
| `@tsir/scout`     | Add `openSearchEngine()` (AWS) and `vectorizeEngine()` (Cloudflare).         |

### P2 — VPS-optimized presets

| Package        | Work                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tsir/forge`  | Add an SSH provider, then first-class Hetzner / DO / Vultr / Linode / Lightsail providers (API key + server provisioning).                                          |
| `@tsir/deploy` | Add `hetzner`, `digitalocean`, `vultr`, `lightsail`, `linode` as named targets that wrap the `vps` target with provider-specific defaults (firewall, DNS, storage). |

---

## Provider-specific notes

### Hetzner

- No managed Postgres/Redis — self-host via Docker.
- No native object storage — use **MinIO** (S3-compatible) on a Hetzner box, or Backblaze B2.
- Compute is cheap; good for self-hosting the full stack.

### DigitalOcean

- **DO Spaces** is S3-compatible → `s3Driver` works with `endpoint: https://<region>.digitaloceanspaces.com`.
- Managed Postgres + Redis available → `@tsir/database` and `@tsir/cache` work out of the box.

### Vultr

- Object Storage is S3-compatible (`endpoint: https://<region>.vultrobjects.com`).
- Managed Postgres + Redis available.

### Amazon Lightsail

- **Lightsail buckets** are S3-compatible → `s3Driver` works.
- Managed Postgres available; Redis is self-hosted.
- Bridges VPS and AWS: use SQS, SES, Lambda from AWS while hosting the app on Lightsail.

### Linode (Akamai)

- Object Storage is S3-compatible (`endpoint: https://<cluster>.linodeobjects.com`).
- Managed Postgres + Redis available.

---

## Verification

Each VPS target gets a conformance matrix:

1. `@tsir/database` — migrate + query against the provider's managed Postgres.
2. `@tsir/cache` — get/set/expire against managed Redis.
3. `@tsir/storage` — put/get/delete against the S3-compatible store.
4. `@tsir/queue` — enqueue + process a job via the database driver.
5. `@tsir/deploy` — boot the app with `vps` target + docker-compose.
6. `@tsir/media` — process one image via sharp on the VPS.

This matrix lives in `@tsir/deploy`'s conformance suite; each provider is a
CI matrix entry (or a manual runbook for providers without free tiers).
