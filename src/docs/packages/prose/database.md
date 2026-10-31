## Example

Create a database from a driver and run a statement on it. This example uses a stub D1 binding so it
runs with no Cloudflare account. In a Worker, pass the real `env.DB` binding instead.

```ts
import { type D1Like, createD1Driver, createDatabase, statement } from '@tsir/database';

const binding = {
  prepare: () => ({
    bind() {
      return this;
    },
    all: async () => ({ success: true, results: [{ one: 1 }] }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  }),
  batch: async () => [],
} as unknown as D1Like;

const database = createDatabase({ driver: createD1Driver({ binding }) });
const result = await database.query(statement('select 1 as one'));

console.log(result.rows);
```

## Failure modes

- `DB_UNKNOWN_CONNECTION`: a connection name was used that is not declared. The message lists the
  declared connections.
- `DB_UNKNOWN_DEFAULT`: the default names a connection that is not declared.
- `DB_NO_CONNECTIONS`: no connections are declared.
- `DB_CLOSED`: a query was made after the database was closed.
- `DB_DRIVER_UNAVAILABLE`: the driver is not available on this target, such as a Node driver inside a
  Worker. The message gives the target and the reason.
- `DB_HEALTH_FAILED`: the health check could not reach the database.
- `DB_BATCH_EMPTY`: a batch was sent with no statements.
- `DB_TX_INTERACTIVE_UNSUPPORTED`: the driver cannot hold a transaction open across several statements.
  Use `batch([...])` instead, or choose a driver that supports it.
- `DB_TX_OPTION_UNSUPPORTED`: a transaction option is not supported on this driver.
- `DB_TX_DEPTH_EXCEEDED`: transactions are nested deeper than the limit.
- `DB_REQUIRES_INTERACTIVE_TX`: a component needs interactive transactions, but the driver has none.
  The message names the component.
- `DB_REQUIRES_TX_CONNECTION`: a component needs a transaction, but was given a connection outside one.
- `DB_CAPABILITY_MISMATCH`: a driver declares interactive transactions without `begin()`, or the other
  way round. This is a bug in the driver.
- `DB_CONNECTION_PIN_UNSUPPORTED`: the driver cannot pin a connection to one request.
- `DB_CODEC_INVALID_NAME`: a column codec has no name. A name identifies the stored format, so an
  anonymous codec cannot be audited.
- `DB_CODEC_INVALID_COLUMN`: a table or column name is not a plain SQL identifier. Column codecs are
  declared in code and never from request data.
- `DB_CODEC_DUPLICATE_COLUMN`: a column is declared with two codecs. A column has one storage format.
- `DB_CODEC_UNDEFINED_VALUE`: a codec column was given `undefined`. Pass `null` for no value.
- `DB_ROTATION_INVALID_IDENTIFIER`: a rotation was given a table or column that is not a valid
  identifier.
- `DB_ROTATION_TARGET_MISMATCH`: a rotation store is used for a different column from the one it was
  built for.

- `DB_RAW_UNSUPPORTED`: the Postgres client cannot return rows by position, which the `arrays` row format
  needs. Use a client that implements `raw()`, such as postgres.js. The driver does not guess column order.
- `DB_BATCH_UNSUPPORTED`: the Postgres client has no `begin()`, so `batch()` cannot be atomic. Pass a client
  built by postgres.js.

## Security notes

Queries use bound parameters, and the names of tables and columns are checked as identifiers, so request
data never becomes SQL text. Logged SQL is scrubbed of parameter values before it is written. Keep
connection strings and bindings in the platform's secret store, and pass them to the driver rather than
writing them into code.
