## Example

An engine is three methods: `index`, `remove`, `search`. This one is in-memory — the right default for
tests and for a corpus that fits in the isolate — and it satisfies the same conformance kit as the
SQL and hosted engines.

```ts
import { conformanceCases, memoryEngine } from '@tsir/scout';

const engine = memoryEngine();
await engine.index({ id: 'post-1', fields: { title: 'Hello world' } });

const hits = await engine.search('hello');
if (hits[0]?.id !== 'post-1') throw new Error('not found');

// The same kit every shipped engine passes; run it against your own engine too.
const cases = conformanceCases({ engine, prefix: 'example-kit' });
for (const conformanceCase of cases) await conformanceCase.run();
console.log(`${hits.length} hit, ${cases.length} conformance cases passed`);
```

## Failure modes

- `CAP_DRIVER_MISSING`: the `search.driver` name is not one this build ships, or a `typesense` engine
  was configured without a `host`. The hint lists the six driver names. A `memory` engine is never a
  silent fallback for a missing hosted one — that would return nothing from a corpus nobody indexed.
- `CAP_FORBIDDEN_IN_PRODUCTION`: `memory` was selected while the app runs with `production: true`. A
  `Map` per isolate means whichever isolate took the write is the only one that finds the document,
  so a search whose result depends on routing is worse than an error.
- `CAP_DISPATCH_FAILED`: the queue-backed indexer could not enqueue an `index`/`remove` job — either
  the dispatch threw, or the backend answered `accepted: false` because it dropped the message as a
  duplicate. The write did not happen and the error says so; retrying the dispatch is safe because
  both jobs are idempotent. There is deliberately no inline fallback, because a write that appears to
  succeed and is not indexed is a document that cannot be found.

A `404` from a hosted engine on `remove` is **not** a failure: the document is gone, which is what the
caller asked for. Every other non-2xx raises `HostedSearchError`, which names the provider and the
operation and never echoes the key.

## Security notes

Search queries are user input and reach a network service, so the hosted engines send them as JSON
bodies and headers rather than interpolating them into a URL — a query containing `&` or `#` must not
become a different request. Keys are supplied as `{ fromEnv: 'NAME' }` and resolved at construction;
a key that is `undefined` refuses at boot, and no error message, log line or `context` field carries
the value.

`fields` are sent to the provider in full. An index is a second copy of your data with a different
access policy, so index the fields you intend to search and display, not the row: a `password_hash` or
a private note that reaches an index is readable by anyone holding a search key, and deleting the row
does not delete the copy.

The SQLite engine builds its FTS table from identifiers you supply; nothing in this package quotes
user input into SQL. If you pass a caller-controlled table or column name to `sqliteEngine`, you have
stepped outside what the package validates.
