## Example

`createTelemetryBootstrap` builds the two services and the DI tokens for them. Tell it which engine
your connection speaks — `'d1'` (the default), `'sqlite'` or `'postgres'` — because the tables are
built for that dialect, not adapted to it.

```ts
import { Database } from 'bun:sqlite';
import { createDatabase, createDrizzle, createSqliteDriver } from '@tsir/database';
import { createTelemetryBootstrap, telemetryTableDdl } from '@tsir/telemetry';

// The app owns the connection and this package never opens one. On Cloudflare it passes the one the
// database bootstrap built from the `DB` binding; an in-memory SQLite file stands in here.
const database = createDatabase({
  driver: createSqliteDriver({ handle: new Database(':memory:') }),
});
for (const statement of telemetryTableDdl('sqlite'))
  await database.query({ sql: statement, params: [] });

const { requestLogger, queueMonitor } = createTelemetryBootstrap({
  drizzle: createDrizzle(database),
  engine: 'sqlite',
});

await requestLogger.record({ method: 'GET', path: '/health', status: 200, durationMs: 3 });
const counts = await queueMonitor.countsByState();

// The stats come from the tables the migration above created — the same objects the services query.
console.log(
  `${String(telemetryTableDdl('sqlite').length)} statements, ${String(counts.pending)} pending`,
);
```

## Failure modes

This package owns no error codes. It reads and writes tables that other packages define, so its
failures arrive as theirs:

- A Drizzle error from a query means the tables do not exist yet — run `telemetryTableDdl(engine)`
  in a migration — or that the connection is on a dialect the factory was not told about. That second
  one is the bug this package had: a SQLite table handed to a Postgres connection produces `?`
  placeholders, and Postgres reports a syntax error at the parameter rather than at the table.
- `DB_BATCH_EMPTY` from `retryJob` means the retry built no statements, which should not happen and
  is worth reporting as a defect.

`retryJob` moves a row from `queue_dead` back to `queue_jobs` in one `batch()`. It does not use
`transaction()`: D1 rejects `BEGIN`, so a transaction works on Postgres and fails on the default
target, which is the shape of every bug this package has had.

## Security notes

The request logger stores method, path, status, duration, a principal subject, IP and user agent —
and nothing else. Request and response bodies are never accepted by its interface, and `authorization`,
`cookie` and `set-cookie` are not fields it can write. That is deliberate: a request log is a table
that survives long after the request, is queried by support staff, and is the first place a leaked
token would be found.

The principal subject is the identity, not the credential. Passing a session token, an API key or a
password hash into `principalSubject` puts it in a table with weaker access control than the one it
came from.

The queue monitor reads job payloads, which means it displays whatever the application put there. It
does not redact them: a payload containing personal data is visible to anyone who can open the
monitor, so put identifiers in job payloads rather than records.

## Query monitoring

`createQueryMonitor` turns the events `@tsir/database` already emits into rows you can read. Nothing
constructs it for you: pass the same Drizzle instance the app uses, and hand `record` to the
connection's sink.

```ts
import { createQueryMonitor } from '@tsir/telemetry';

const queryMonitor = createQueryMonitor({ drizzle, engine: 'd1' });
const databases = createConnectionsFromConfig(config, bindings, {
  log: (e) => void queryMonitor.record(e),
});
```

It keeps the last `bufferLimit` statements in memory — so a page works before the migration has run
— and writes each one to `query_logs`. Three readers: `recent()`, `failures()` and `slowerThan(ms)`.

Two rules are worth knowing before you wonder why a statement is missing. The monitor **does not
record its own insert**: the insert goes through the same driver, which emits an event, which would
record another row. The guard is the statement text, because a re-entrancy flag cannot be correct
across an `await`. And a failure to write a row is counted in `dropped` rather than thrown: the
statement already ran, and a monitor that can fail a request is a monitor that will be switched off.

`level: 'slow'` (the default) keeps slow statements and **every** failure, because a fast failure is
still a failure. That is also what `logging: 'off'` does now — it silences routine statements, not
its own incident.
