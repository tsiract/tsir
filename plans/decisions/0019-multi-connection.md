# ADR-0019 — Named connections: many of one port, selected per call

- **Status:** Accepted
- **Date:** 2026-10-28
  **Amends:** [ADR-0016](./0016-cloudflare-first-and-d1.md) § 2 — the `database.driver` key becomes `database.connections.<name>.driver`; the engine set and the D1 default are unchanged.
  **Supersedes:** none · **Related:** [ADR-0015](./0015-capability-drivers.md) (capability drivers), [ADR-0016](./0016-cloudflare-first-and-d1.md) (D1 default), [ADR-0009](./0009-postgres-transport.md) (Postgres transport), [ADR-0012](./0012-dependency-policy.md) (dependency policy)

## Context

Until now every port in Tsir has been **singular**. `tsir.js` names one
`database.driver`, one cache driver, one queue driver, and the container resolves
exactly one instance of each. That is enough for a scaffold and wrong for almost
every application that survives its first year:

- a read replica, or an analytics database that must never see the primary's
  connection budget;
- one D1 database for the application and a second one for the cache, because D1
  serializes writes per database (ADR-0016 § 1.4);
- an import job that writes to a staging schema;
- a `sessions` cache that needs `readYourWrites` next to a `pages` cache that does
  not, and a `heavy` queue drained by a different worker with a different
  concurrency;
- a second, unrelated database owned by a module that was extracted from another
  service.

The single-instance model forces all of these into one connection, or into
`process.env` juggling and a second container binding — which is how a framework
ends up with `Database` and `Database2`.

Laravel solves this with named connections and a per-call selector:
`DB::connection('reporting')->select(...)`, `Cache::store('sessions')`,
`Queue::connection('heavy')->push(...)`. That shape is proven, and the vocabulary
is already familiar to the audience this project targets. What Tsir must change
is where the _safety_ comes from: PHP discovers a bad connection name at runtime,
and a per-call selector in a typed framework must be a closed set checked by the
type system and at boot.

## Decision

**Every driver-based port resolves by name from a declared registry, and every
call site may name a connection explicitly. The name is a first-class, closed,
checked coordinate — never a string that quietly falls back to the default.**

### 1. Registry keyed by name; the driver is a property of the entry

```js
// tsir.js
database: {
  default: 'app',
  connections: {
    app:       { driver: 'd1', binding: 'DB' },
    reporting: { driver: 'postgres', url: { fromEnv: 'REPORTING_URL', secret: true }, pool: { max: 4 } },
  },
},
```

The registry key is **not** the driver. A project may hold three `postgres`
connections and one D1 connection; the name says _what it is for_, the driver says
_how it is reached_. Configuration that cannot express two connections with the
same driver is not multi-connection support, it is a rename.

The same shape applies to every port that has drivers:

| Port     | Registry      | Default key        | Per-call selector            |
| -------- | ------------- | ------------------ | ---------------------------- |
| Database | `connections` | `database.default` | `database.connection(name)`  |
| Cache    | `stores`      | `cache.default`    | `cache.store(name)`          |
| Queue    | `connections` | `queue.default`    | `queue.connection(name)`     |
| Mail     | `mailers`     | `mail.default`     | `mailer(name)`               |
| Storage  | `disks`       | `storage.default`  | `storage.disk(name)`         |
| Schedule | `connections` | `schedule.default` | `scheduler.connection(name)` |

Laravel's word for the cache is **store**, and the word for queue and database is
**connection**; Tsir keeps that split because it is the one place the Laravel
vocabulary carries real information — a cache store is not a connection to
anywhere in particular.

### 2. The default is explicit, and an unknown name is an error

```ts
await db.connection('reporting').query(sql); // declared in tsir.js → allowed
await db.connection('reportng').query(sql); // DB_UNKNOWN_CONNECTION, with the list of names
```

- `connection(undefined)` returns the default. `connection('typo')` **throws**:
  `DB_UNKNOWN_CONNECTION` (cache: `CAP_UNKNOWN_STORE`) listing the names that
  exist. A silent fallback to the default is how a reporting query ends up
  writing to production.
- The _set_ of names is statically known: `tsir.js` is processed at build time
  (ADR-0006), so `connections` is a literal type and the argument is
  `keyof DatabaseConnections`, not `string`. A typo is a type error before it is a
  runtime error, and the runtime check exists for the `tsir.js`-edited-out-of-band
  case only.
- Resolution order, identical to § 3.2 of `15-capabilities.md`:
  **call argument → injected token → `*.default` → boot failure.**

### 3. `connection(name)` returns the port, not a proxy

`database.connection('reporting')` returns a `Database` — the same contract, the
same transaction API, its own pool, its own capabilities. There is no
`ReportingDatabase` type and no widened interface: code written against
`Database` works against any connection, which is the only way a test can run
against D1 and a deployment against Postgres.

Constructor injection names the connection at the token level
(`@InjectDatabase('reporting')`), because an injection that is decided inside the
method body is a hidden dependency the container cannot report.

### 4. Capabilities are per connection, and checked at boot

`capabilities` is a property of the driver instance, so two connections to the
same engine may differ (D1 with and without bindings, Postgres with
`interactiveTx` and a D1 fallback). Declaring a requirement names the connection:

```ts
requires: { database: { connection: 'reporting', interactiveTx: true } }
```

Boot fails with `DB_CAPABILITY_UNSUPPORTED` naming both the connection and the
capability. The failure mode this prevents is the one that only shows up in
production: a rate limiter pointed at a store without `atomicIncrement`, or a
maintenance loop that expects `interactiveTx` and got D1.

### 5. No cross-connection transactions, ever

A transaction is scoped to one connection. `interactiveTx` on connection A cannot
enlist connection B, and there is no two-phase-commit emulation:

```
tx on 'app' + write to 'reporting'  →  DB_CROSS_CONNECTION_TX
```

The transaction-scoped `Database` handed to the callback **is** the connection:
it exposes no `connection()` selector, so the mistake is not expressible. Where
two connections must change together, the answer is a transactional outbox on the
first connection and an idempotent consumer on the second (`15-capabilities.md`
§ 4.2) — the same answer as for a queue, because it is the same problem.

### 6. Read replicas are never implicit

There is no `replica: true` flag that silently routes reads to a second
connection. Replica reads are an explicit call —
`db.connection('replica').query(...)`, or a repository that names the connection —
because read-your-writes violations are invisible in tests and expensive in
production. The framework may _offer_ `db.replica()` for the common case, but it
never rewrites a query's target.

### 7. Drivers stay statically imported

Multiplicity is at the **connection** level, not the driver level. `tsir build`
still emits a static `drivers.gen.ts` for the set of drivers that appears in
`tsir.js`; a registry with two entries sharing one driver emits one import. There
is still no runtime `import('@tsir/database/' + engine)` (ADR-0012), and no way
for a config file to add a dependency to the bundle.

### 8. The connection name is an observability dimension

Every query log line, span, metric and health result carries
`db.connection: <name>`. An `EXPLAIN` on the wrong connection is a support ticket;
a dashboard that cannot separate `app` from `reporting` is a blind spot. Health
reports per connection, and readiness aggregates them with an explicit
`required: true|false` per connection (`13-observability.md`).

### 9. Naming correction: `Database.connection()` is taken

`DB-018` added `Database.connection(fn)` to pin one physical connection for
session-scoped state (advisory locks). That name is now the multi-connection
selector. The pinning primitive is renamed **`Database.pinned(fn)`**:

| Before (`DB-018`)         | After                            |
| ------------------------- | -------------------------------- |
| `db.connection(fn)` (pin) | `db.pinned(fn)`                  |
| —                         | `db.connection(name)` (registry) |

The rename is mechanical, touches `migrate`/`rollback` call sites and two tests,
and is scheduled as part of `DB-019` rather than as a separate breaking change —
the package has no released consumers yet.

### 10. Engines are not connections, and MySQL is an engine question

Adding a _connection_ is config. Adding an _engine_ is a driver, a dialect, a
placeholder syntax, a DDL review and a dependency review (ADR-0012). MySQL /
MariaDB requested by name is therefore **not** satisfied by this ADR: the registry
is built so that it _can_ hold a `mysql` entry (nothing in the design assumes the
engine set), and the engine itself stays behind `Q14` and its own ADR. Concretely,
`DB-019` must not encode `'d1' | 'postgres'` into the registry's public type — the
engine union stays in the driver package, and the registry is generic over it.

## Consequences

**Positive**

- One process can hold a primary, a replica, an analytics database and a
  per-purpose cache without a second container binding or an environment variable
  dance.
- Capability requirements become per-connection, so a mixed D1/Postgres
  deployment is verifiable at boot instead of at 03:00.
- Observability gets a dimension it needs anyway, and migrations/seeders get a
  `--connection` flag they will need on day one of a second database.

**Negative / costs**

- `tsir.js` grows a level of nesting for every driver port, and the generator must
  scaffold the first connection rather than a flat block.
- Every command that talks to a store gains `--connection` (`--store`), and their
  default must come from config, not from the command.
- A test that touches two connections needs two harnesses; `createTestDatabase()`
  takes `{ connection }` for exactly this reason.
- The `DB-018` rename invalidates existing docs and two tests; cheap now, not
  later.

## Alternatives rejected

| Alternative                                     | Why not                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Second container binding (`Database2`)          | Unnamed, untypable, invisible to boot checks and to observability. The name is the feature.                                                                                    |
| One connection per process (env var per unit)   | Wrong for the common case: an HTTP request legitimately reads a replica and writes the primary. Forcing process-level separation turns a config choice into a deploy topology. |
| Runtime driver registry with dynamic `import()` | Bundle-size and supply-chain liability (ADR-0012); a config file could add code to the bundle.                                                                                 |
| Automatic read/write splitting                  | Silent stale reads. Rejected for the same reason `15-capabilities.md` refuses semantic downgrades.                                                                             |
| Cross-connection transactions via 2PC           | No target supports it (D1 explicitly not), and it does not survive serverless. The outbox is the portable answer.                                                              |
| String-typed names with a runtime lookup table  | Defers typos to production. `tsir.js` is compiled; the type should carry the names.                                                                                            |
