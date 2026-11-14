## Example

A flag is a name and a rule. The manager asks the rule a question, and the rule answers without a
database, a network call, or a cache: a percentage rollout is a hash of the flag name and the subject,
so it returns the same answer for the same user on every instance.

```ts
import { createFeatureManager, memoryStore } from '@tsir/pennant';

const manager = createFeatureManager(
  memoryStore([
    { name: 'new-checkout', rule: { type: 'percentage', value: 10 } },
    { name: 'dark-mode', rule: { type: 'boolean', value: true } },
  ]),
);

// The same subject gets the same answer every time — that is the whole contract of a live rollout.
console.log(await manager.active('new-checkout', { userId: 'u_123' }));
console.log(await manager.active('new-checkout', { userId: 'u_456' }));
console.log(await manager.active('dark-mode', { userId: 'u_123' }));
```

## Failure modes

- `PENNANT_ENGINE_UNSUPPORTED`: a `database` store was given a `mysql` connection. The store writes
  with `ON CONFLICT (name) DO UPDATE`, which is SQLite's and Postgres's syntax; MySQL's equivalent
  refuses the statement at construction rather than writing a half-updated flag whose next read
  decides a rollout.
- `PENNANT_DRIVER_MISSING`: the driver named in `tsir.js` is not one of `database`, `memory`, `null`.
  A misspelled driver must not fall through to a default, because the default that works in
  development is the one that loses flags in production.
- `PENNANT_FORBIDDEN_IN_PRODUCTION`: a `memory` or `null` store was configured for production. Both
  reset on every deploy, so a flag would be evaluated against an empty store — every rollout off, or
  worse, on for everybody.
- `PENNANT_DEFAULT_MISSING`: `featureFlags.default` names a store the registry does not declare. The
  message lists the declared stores.
- `PENNANT_NO_STORE`: the `featureFlags` block declares no stores, or the chosen store has no
  definition. There is nothing to read a flag from, and answering `false` would silently disable
  every rollout.
- `PENNANT_CONFIG_MISSING`: a `database` store was built without the connection query it reads
  through. The store is a query function and a table; without the function, the hint says which
  option to pass.

## Security notes

A flag is a deployment control, not an authorisation check. `active()` decides which code path runs;
it does not decide whether the caller may run it, which stays with `@tsir/policy`. Evaluating a flag
for a subject means the subject id reaches the store as a bound parameter, never as SQL text, and a
`database` store reads through the same connection — and therefore the same redaction and slow-query
logging — as every other statement in the application.

A rollout is only trustworthy if the rule is. `memory` and `null` are refused in production because
a flag that resets is a rollout that flips, and the failure is silent: the next `active()` call simply
returns a different answer than the last one did.
