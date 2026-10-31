# `@tsir/testing`

Test harness for Tsir applications. Everything here runs in the test process; nothing is exported by the production packages.

## Application tests

- `createTestApp(app, { env?, overrides?, only? })` boots the app through the production `createApp` path and returns a `TestApp` with `get(token)`, `routes()`, and `dispose()`.
- `dispose()` fails with `TEST_ROUTE_LEAK` if a controller was registered after boot, and with `TEST_HANDLE_LEAK` if a referenced timer is still running.
- `createTestDatabase()` gives each suite its own schema.

## In-process HTTP

- `createTestClient(handler, { origin? })` builds a `Request` and calls the handler directly, with no socket. It has `get`, `post`, `put`, `patch`, `delete`, `request`, and a `json` shortcut.
- `expectProblem(response, { status, code? })` checks the `application/problem+json` body and returns it.

## Determinism

- `fixedClock(start?)` is a clock that only moves when told to.
- `seededRandom(seed)` gives `next()`, `uuid()`, and `bytes(length)`. The same seed gives the same values.
- `seededIds(seed, prefix?)` gives `IdGenerator`: `next()` returns `<prefix>_<32 hex>`, and `reset()` starts the sequence again.

## Guards

- `installNetworkGuard({ allowHosts? })` refuses outbound `fetch` to non-loopback hosts with `NETWORK_BLOCKED`. The test preload installs it.
- `beginHandleTracking()` records referenced timers started while it is active and returns the ones still running when it is ended.

## Assertions

- `expectTsirError(run, code)` asserts on the error code, not the message.
