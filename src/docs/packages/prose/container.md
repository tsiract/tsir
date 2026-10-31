## Example

Register a class under a token, resolve it, and dispose the container when you are done.

```ts
import { Container, classProvider, token } from '@tsir/container';

interface Clock {
  now(): number;
}

const ClockToken = token<Clock>('Clock');

class SystemClock implements Clock {
  now(): number {
    return 42;
  }
}

const container = new Container();
container.register(classProvider(ClockToken, SystemClock, []));

console.log(container.resolve(ClockToken).now());
await container.dispose();
```

## Failure modes

- `CTN_NO_PROVIDER`: a token is resolved that nothing registered. Register a provider for it, or
  check the spelling of the token.
- `CTN_DUPLICATE`: two providers were registered for one token. Keep one provider per token.
- `CTN_CYCLE`: providers depend on each other in a loop. Break the loop with a lazy dependency.
- `CTN_DEPTH`: resolution nested deeper than the container's depth limit.
- `CTN_ASYNC_PROVIDER`: an async factory was resolved with `resolve()`. Use `resolveAsync()`.
- `CTN_FACTORY_FAILED`: a provider's factory threw. The original error is kept in the context.
- `CTN_NO_SCOPE` and `CTN_DISPOSED`: a scoped provider was resolved outside a scope, or the container
  was used after `dispose()`.
- `CTN_DISPOSE_FAILED`: one or more disposables threw during `dispose()`. The rest still ran.
- `CTN_OVERRIDE_UNKNOWN`: a test override names a token that is not registered.

- `INTERNAL_UNEXPECTED`: a value that is not a `TsirError` reached a boundary and was wrapped. The
  original error is kept as `cause`, so treat it as a bug in whatever threw it. A boundary can pass its
  own fallback code instead.

## Security notes

The container holds references and nothing else. It does not read the environment, open files or
network connections, and it has no global instance, so two containers never share state. Keep secrets
out of token descriptions: the description appears in error messages.
