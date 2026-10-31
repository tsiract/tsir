## Example

Describe the application's routes and modules, then build the unit graph. The graph says which units
exist, which routes each one serves, and what each needs. Building it checks the description before
anything is deployed.

```ts
import { buildGraph } from '@tsir/deploy';

const { graph } = buildGraph({
  appName: 'acme',
  routes: [
    { method: 'GET', path: '/health', module: 'ops' },
    { method: 'GET', path: '/api/orders', module: 'orders' },
  ],
  modules: [
    { name: 'orders', requires: [] },
    { name: 'ops', requires: [] },
  ],
});

console.log(
  graph.topology,
  graph.units.map((unit) => unit.name),
);
```

## Failure modes

- `DPL_CONFIG_INVALID`: the deploy configuration is invalid. The check runs before anything is built.
- `DPL_UNSUPPORTED_TARGET`: a target was named that is not configured. The message lists the configured
  targets.
- `DPL_CAPABILITY_MISSING`: a unit needs a capability that the target does not have, such as raw
  sockets on Cloudflare. The message names the target and the module that required it.
- `DPL_UNIT_EMPTY`: a unit resolved to no handlers. Check `deploy.units` for a typo, or for a module
  that did not load.
- `DPL_DUPLICATE_ROUTE`: two units claim the same method and path. A route belongs to exactly one unit.
- `DPL_BINDING_MISSING`: a unit uses a binding that the target does not declare.
- `DPL_CLASS_MISSING`: a Durable Object binding names a class that the bundle does not export.
- `DPL_QUEUE_TRIGGER_MISSING`: a queue connection's driver cannot be triggered on the target it is declared
  for. The message names the targets that can run it.
- `DPL_QUEUE_OUTBOX_MISSING`: a queue connection uses a driver that cannot enqueue inside a database write,
  and declares no outbox. Set `outbox: true` and write the job through the outbox.
- `DPL_EVENTS_OUTBOX_MISSING`: a queue connection declares an outbox, but the project exports no events
  registry to write to it. Export `events` from the application entry.
- `DPL_CRON_INVALID`: a schedule's cron expression is not valid.
- `DPL_CRON_NOT_UTC`: a schedule's time is not in UTC, and the platform cannot express the offset.
  Workers and EventBridge fire cron triggers in UTC, so write the UTC hour.
- `DPL_SIZE_BUDGET`: a unit's bundle is over its size budget.
- `DPL_ENV_LIMIT`: a target would receive more environment variables, or more bytes of them, than it
  allows.
- `DPL_PRIVATE_EXPOSED`: a unit is private, but its generated artifact can be routed publicly.
  Regenerate with `tsir deploy:build`.
- `DPL_SECRET_LEAK`: a generated file contains a value that looks like a secret. Secrets belong in
  bindings, not in strings.
- `DPL_GRAPH_DRIFT`: the unit graph has changed since it was last accepted. Review the change, then run
  `tsir deploy:plan --write` to accept it.
- `DPL_EVENT_UNRECOGNISED`: a Lambda invocation carried an event shape the unit does not handle.

## Security notes

A private unit must not be routable from the public internet, and the check compares the graph's
statement with the generated configuration. Secrets never appear in generated files: they are
platform bindings, set with `wrangler secret put` on Workers or Secrets Manager on Lambda. A scan of the
generated output looks for secret-shaped values. Review the graph diff before accepting it, because a
changed route or unit changes what is exposed.
