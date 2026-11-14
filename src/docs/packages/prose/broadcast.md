## Example

A broadcaster is a fan-out port with two methods: publish a message to a channel, and subscribe to a
channel. The in-process driver is the one to develop against — it delivers synchronously, so a test
that publishes and then asserts does not need a sleep.

```ts
import { memoryBroadcaster } from '@tsir/broadcast';

const broadcaster = memoryBroadcaster();

const unsubscribe = broadcaster.subscribe('orders', (message) => {
  console.log(message.channel, message.event, JSON.stringify(message.data));
});

await broadcaster.publish('orders', 'created', { id: 1 });
await broadcaster.publish('orders', 'shipped', { id: 1 });

// Unsubscribing is the returned function, not a method: a forgot return value is a listener leak
// that only shows up as a slow test process.
unsubscribe();
await broadcaster.publish('orders', 'created', { id: 2 });
console.log('after unsubscribe:', 'no third line');
```

## Failure modes

- `CAP_DRIVER_MISSING`: `broadcast.default` names a driver that is not registered, or the driver
  needs a binding it does not have — `redis` without a pub/sub client, `pusher` without its keys,
  `durable-object` without a namespace. The message names the driver and the `tsir.js` path to fill
  in. Nothing falls back to `memory`: a broadcaster that works in development and silently fans out
  to nobody in production is worse than one that refuses at boot.
- `CAP_FORBIDDEN_IN_PRODUCTION`: a `memory` broadcaster was configured for production. It only
  reaches listeners in the same process, so a `publish` from one Worker isolate reaches nobody on
  another — the failure looks like "the UI never updates", not like an error.
- `CAP_UNKNOWN_CONNECTION`: a channel was published through a connection name that is not declared.
  The message lists the declared connections.

## Security notes

A channel name is not an authorisation boundary. `subscribe` is in-process and takes whatever the
caller passes; the HTTP and WebSocket entrypoints are where a name becomes reachable by a browser,
and that is why `createWebSocketHandler` takes an `authorize` callback and calls it per channel
before the socket joins. A private channel's prefix (`private-`) is a naming convention, not a check —
the check is the callback.

`pusherBroadcaster` and `redisBroadcaster` send what they are given to a third party, so the payload
is the boundary: an event that carries a user record carries it to the provider's servers. Publish an
id, and let the client fetch the row through a route that applies the policy.
