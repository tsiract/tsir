## Example

Declare a named store with a codec, then read and write through it. The codec decides how a value
is stored, so a value written as JSON is read back as JSON, not guessed at.

```ts
import { createCaches, defineStore, json } from '@tsir/cache';
import { memoryDriver } from '@tsir/cache/memory';

interface Session {
  userId: string;
  role: string;
}

const caches = createCaches({
  default: 'sessions',
  stores: {
    sessions: defineStore({ driver: memoryDriver(), codec: json<Session>() }),
  },
});

const store = caches.store('sessions');
await store.set('u:1', { userId: 'u1', role: 'admin' });

console.log(await store.get('u:1'));
```

## Failure modes

- `CAP_UNKNOWN_STORE`: a store name was used that was never declared. There is no fallback to the
  default store, so the code asks for a store it cannot have.
- `CAP_UNKNOWN_DEFAULT`: the default names a store that is not declared.
- `CAP_NO_STORES`: no stores are declared at all.
- `CAP_UNSUPPORTED_OPERATION`: the store's driver cannot do what was asked, for example tags on a
  driver without a tag index, or counting on a driver that cannot increment. The message names the
  store and the driver.
- `CAP_DRIVER_MISSING`: the store names a driver that is not registered, or a client that is missing
  commands the driver needs. Startup fails, so the problem appears before any request does.
- `CAP_FORBIDDEN_IN_PRODUCTION`: a store uses an ephemeral driver in production. `memory` and `null`
  are refused, because they would pretend to be durable.
- `CAP_CODEC_FAILED`: a value could not be encoded, or could not be decoded by the codec that stored
  it. The message names the store and the key.

## Security notes

A cached value is only read back by the codec that wrote it. A codec is never inferred from the
stored bytes, so the package never parses a payload it did not expect. Stores are named and
declared, so a request cannot reach a store that was not configured. An ephemeral driver is refused
in production, which prevents a session store from silently losing every session on restart. Keep
secrets out of keys, because keys appear in logs and in the operator commands that list entries.
