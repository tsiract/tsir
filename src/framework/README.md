# `src/framework/`

The framework. Every directory here is a Bun workspace package with an entry point, at least one
test, and an entry in the dependency graph of [](././)
— enforced by `src/tools/check-boundaries.ts` in `make check` and CI.

These packages are **distributed** as the flattened tree in `dist/framework/<name>/`
(`make dist`, ADR-0011). The repository keeps a per-package `src/`; the distributable does not.

## What exists today (Phase 1)

| Package           | Depends on                                | Contents                                                                             |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `@tsir/container` | —                                         | `token`, `contract`, providers, `Container`, scopes, disposal, `TsirError`           |
| `@tsir/config`    | `container`, `validate`                   | `defineConfig`, `env.*`, `loadConfig`, `Redacted`, boot reports                      |
| `@tsir/core`      | `container`, `config`                     | `bootstrap`, `defineModule`, manifests, capability probes, `defineApp`, clock/random |
| `@tsir/validate`  | `container`, **`zod`**                    | Zod 4 foundation + Standard Schema interop, `validate`/`validateSync`/`parse`        |
| `@tsir/testing`   | `container`, `config`, `core`             | `createTestApp`, `fixedClock`, `seededRandom`, `expectTsirError`                     |
| `@tsir/console`   | `config`, `core`, `container`, `validate` | `runCli`, `COMMANDS` (`dev`, `build`, `doctor`, `config:dump`, `new`, `make:module`) |

Runtime-neutral packages (no `node:*` / `bun:*` imports, enforced by ESLint) hold the core logic —
`container`, `config`, `core`, `validate`, and (Phase 2) `router`/`http`. That neutrality is what
`make verify-dist` measures against the Workers (`browser`) and Lambda (`node`) targets.

**Dependencies:** `zod` is the only third-party runtime dependency in the whole workspace, and
`@tsir/validate` is the only package allowed to declare it (ADR-0012). Everything else imports
`z` from there, so there is exactly one validator and one version.

## The Phase 7 packages

Everything below is built, tested and covered by the gate in `make coverage`; each has a task
README recording what it ships and what it does not.

| Package          | Depends on                    | Contents                                                                         |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `@tsir/cache`    | `container`, `core`, `config` | Port, codecs, 5 drivers, `cache:*`, a conformance kit                            |
| `@tsir/queue`    | `container`                   | Port, worker, 5 drivers, outbox, `queue:*`, per-connection triggers              |
| `@tsir/events`   | `container`, `queue`          | Typed dispatch, sync/queued listeners, the transactional outbox writer           |
| `@tsir/schedule` | `container`                   | Cron parser, task registry, the tick, `LockProvider` + 2 drivers, `schedule:*`   |
| `@tsir/storage`  | `container`                   | Disk registry, 3 drivers, SigV4 in WebCrypto, `storage:*`                        |
| `@tsir/mail`     | `container`, `storage`        | Mailers, 7 transports, templates, MIME, `mail:*`                                 |
| `@tsir/notify`   | `container`, `mail`, `queue`  | Channels (mail, database inbox, webhook, chat, sms, memory), queued delivery     |
| `@tsir/policy`   | `container`                   | Roles, permissions, gates, `authorize`/`require`, `toHttpPolicies`               |
| `@tsir/auth`     | `container`                   | Passwords (PBKDF2, argon2id on Bun), sessions, API keys, guards                  |
| `@tsir/pulse`    | `container`                   | Logger + 3-layer redaction, metrics, tracing, health/readiness                   |
| `@tsir/scout`    | `container`                   | Port, 6 engines (FTS5, `tsvector`, 3 hosted, memory), `scout:*`, conformance kit |

Two things are worth noticing in that table. First, every capability package depends on `container`
and nothing else it does not have to — `policy`, `auth` and `pulse` are leaves, which is why a project
can take one of them and leave the rest. Second, `@tsir/pulse` is the only place a log line is
written, and nothing in the framework depends on it: a package that wants to log takes the three
methods it uses, so an application can supply its own logger.

## What appears next

| Phase | Packages                              | Plan   |
| ----- | ------------------------------------- | ------ |
| 2     | `router`, `http`                      | [](./) |
| 3     | `database`, `migrate`, `seed`         | [](./) |
| 4     | `vault`                               | [](./) |
| 5     | `link` (`rest`, `grpc`, `soap`, `ws`) | [](./) |
| 6     | `deploy`                              | [](./) |

A package directory must never exist without an entry point and at least one test — so
this table is a schedule, not a scaffold.

## Adding a package

1. `src/framework/<name>/package.json` with `"type": "module"`, an `exports` map, and `private: true`
   until Phase 8 publishes anything.
2. A `src/index.ts` that is the only public surface.
3. At least one `*.test.ts` beside the source — coverage is gated per package.
4. An entry in the `ALLOWED` table of `src/tools/check-boundaries.ts`, declaring every allowed dependency.
5. A row in the table above.
