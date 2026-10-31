## Example

Make a test deterministic by fixing the clock and the random sequence, then assert on the error code a
function throws. Asserting on the code keeps the test honest when the wording of the message changes.

```ts
import { TsirError, expectTsirError, fixedClock, seededRandom } from '@tsir/testing';

const clock = fixedClock('2026-01-01T00:00:00.000Z');
const random = seededRandom(42);

console.log(clock.iso(), typeof random);

await expectTsirError(() => {
  throw new TsirError('DEMO_FAILED', 'demo failure', { kind: 'validation' });
}, 'DEMO_FAILED');
```

## Helpers beyond the example

- `createTestClient(handler)` calls a fetch-style handler with a `Request`, with no socket. `expectProblem(response, { status, code })` checks the problem body.
- `seededIds(seed, prefix)` returns an `IdGenerator`. The same seed gives the same ids, and `reset()` starts the sequence again.
- `installNetworkGuard({ allowHosts })` refuses outbound `fetch` to hosts other than loopback. The test preload installs it, so an accidental network call fails loudly.
- `createTestApp(...).dispose()` fails when a referenced timer the app started is still running.

## Failure modes

This package defines no error codes of its own. The failures a test can see come from the code under test:

- `expectTsirError` fails the test when nothing was thrown, when the error is not a `TsirError`, or when
  its code is not the one expected. The failure message names the expected code and the received one.
- `dispose()` throws `TEST_HANDLE_LEAK` when a referenced timer started during the app is still running. Clear it in the module's shutdown, or call `unref()` if it must not keep the process alive.
- A test that calls the network while the guard is installed gets `TEST_NETWORK_BLOCKED`, not a real response.
- Code under test that reads the real clock or random source cannot be made deterministic. Pass the clock
  and random source in, so the test can control them.

## Security notes

Test helpers are for tests only, and they are not part of a production build. Test data should be fake:
do not copy production records into fixtures or snapshots, because test output is often stored in
continuous-integration logs. A fixed random sequence is predictable, so it must never be used to produce
a real secret.
