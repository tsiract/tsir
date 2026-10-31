# ADR-0007 — Drizzle's Migration Journal Stays Authoritative

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/migrate`, `@tsir/database`

---

## Context

The brief asks for a "Laravel-inspired migration workflow while using Drizzle's supported migration generation and execution capabilities wherever possible" and says "do not duplicate Drizzle's migration journal or migration engine without a documented reason."

Drizzle Kit already provides: migration generation from schema diffs, ordered SQL files with `meta/_journal.json`, and an `__drizzle_migrations` tracking table.

## Decision

1. **Generation** is delegated to `drizzle-kit generate`, wrapped by `tsir make:migration` only to enforce naming and templates.
2. **Journal and history** remain Drizzle's (`meta/_journal.json` + `__drizzle_migrations`). Tsir does not maintain a parallel migration list.
3. Tsir **adds** only what Drizzle does not provide:
   - a Postgres **advisory lock** preventing concurrent runners,
   - a `__tsir_migration_runs` **audit sidecar** (run id, host, actor, duration, checksum),
   - **checksum drift detection** against applied files,
   - **per-migration transaction policy** via header comment (`-- tsir:transaction=off`),
   - `status`, `verify`, and guarded `rollback` commands,
   - pre-flight guidance for production (locking, backup, rollback plan).
4. Execution order is Drizzle's; Tsir never reorders or skips.
5. Rollback is explicitly documented as **not universally safe**; destructive operations require `--allow-destructive` plus typing the migration name.

## Consequences

**Positive**

- Existing Drizzle tooling, dashboards, and mental models keep working; users can drop to `drizzle-kit` at any time.
- No dual-journal drift — the most common failure mode of wrappers around migration engines.
- Safety features are additive and auditable on their own.

**Negative / costs**

- We inherit Drizzle Kit's limitations (e.g. some Postgres constructs need hand-edited SQL; occasional generation quirks).
- Transaction policy must be expressed in a comment rather than metadata, because journal files are Drizzle-owned.
- Rollback ergonomics are limited by what Drizzle generates; where it cannot generate a `down`, we document a manual procedure instead of pretending.

## Alternatives considered

| Alternative                                   | Why rejected                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Tsir-specific migration engine and journal    | Explicitly discouraged by the brief; large surface; reimplements a solved problem |
| Use `drizzle-kit push` in production          | Unsafe for reviewed changes; no history                                           |
| Node-migrator style (e.g. Umzug) over Drizzle | Adds a second history; conflicts with the journal requirement                     |

## Revisit conditions

If Drizzle Kit ships locking, audit, and transaction-policy features natively, delete the corresponding Tsir code rather than keep a parallel implementation.
