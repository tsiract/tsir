# ADR-0025 — Rooms are Durable-Object-shaped, not Durable-Object-dependent

- **Status:** Accepted
- **Date:** 2026-10-28
- **Affects:** `@tsir/link/ws` (`src/framework/link/src/rooms.ts`), `plans/modules/07-link.md` § 6
- **Related:** [ADR-0022](./0022-subpath-dependency-scope.md) (subpath dependency scope), `DPL-010` (the binding, in phase 6)

---

## Context

`LNK-025` asks for "Durable Objects room model (Workers)" with one acceptance line:
**cross-instance fan-out via DO, documented.** `plans/modules/07-link.md` § 6 is blunt about why:
a socket handler is one conversation in the process that accepted it, so two clients in the
same "room" on two isolates never see each other's messages. That failure is invisible in
development, where there is one process, and obvious in production, where there are many.

Three ways to build it:

1. **Depend on `@cloudflare/workers-types`** and write `DurableObject` classes directly.
   Types-only, but it pulls a platform's ambient declarations into a package that must also
   bundle for Bun, Node and Workers, and it makes the room code untestable outside a
   Workers runtime — the tests would need Miniflare or `wrangler dev` in CI.
2. **Require an application-level pub/sub** (`@tsir/events` + a durable backend, as § 6
   originally proposed). That is the right eventual answer for _arbitrary_ backends, but it
   does not exist yet, and it would leave Workers — the primary target — without the one
   coordination primitive the platform already ships.
3. **Model the room against the shape of the Durable Object API**, and let the deployment
   supply the real object.

## Decision

`@tsir/link/ws` exports `createRoom(state, options)`, which returns the Durable Object
methods a room needs (`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`), and
takes the object's state through a two-method interface:

```ts
export interface RoomState {
  acceptWebSocket(socket: RoomSocket, tags?: readonly string[]): void;
  getWebSockets(tag?: string): readonly RoomSocket[];
}
```

The specific choices that follow from this:

- **Hibernation is the design, not a mode.** Per-connection state lives in the socket
  attachment (`serializeAttachment`) — connection id, room, principal, join time — and
  membership lives in the runtime's own socket list (`getWebSockets(tag)`). There is no
  module-level map of sessions, because a map is exactly what an eviction loses.
- **One tag per room.** Sockets are accepted with `room:<id>`; a broadcast walks
  `getWebSockets('room:<id>')`. One object per room is the normal deployment, but a single
  object hosting several rooms is also correct, and the tests cover the tag filtering
  rather than assuming it.
- **The WebSocket pair is injected.** `deps.pair` defaults to `globalThis.WebSocketPair`;
  tests pass a fake. This is the same seam `WsClientOptions.deps.connect` uses, and it is
  what makes the room model testable without a socket, a runtime, or a network.
- **No invented protocol.** `onMessage` may return a value, which is broadcast to the room;
  returning nothing is silence. `onJoin` may return a value, which goes to the joining
  socket only. Presence is `members()`, not a bespoke frame type. A framework that invents
  a wire protocol for presence has to version it forever.
- **The deployment half is not in this package.** Declaring the binding, exporting the
  class, and adding the `migrations` entry is `DPL-010` in `@tsir/deploy`. A protocol
  package that knows how a Workers deployment is wired is a package that cannot be reused
  on Lambda.

## Consequences

**Good**

- Cross-isolate fan-out is testable in milliseconds: `rooms.test.ts` runs two "isolates"
  against one fake object and asserts the delivery, the room isolation, and that a
  restarted object still reaches sockets accepted before the eviction.
- No dependency, no ambient types, no Workers runtime in CI — and `make verify-dist`
  bundles the room entrypoint for the browser target at ~5 KiB, which is the standing
  proof that the model stays platform-neutral.
- The semantics that matter are the runtime's: single-threaded execution gives one writer
  and therefore an order; at-most-once delivery is unchanged from `LNK-022` (nothing is
  queued or replayed, ever).
- If a second coordinator appears later (a Redis room on Node, a Postgres advisory lock),
  it implements the same two methods and the room code above it does not change.

**Bad, and accepted**

- **No backpressure signal.** Hibernatable sockets have no `bufferedAmount`, so the room
  cannot do what `defineWsHandler` does (`1013` close on a peer that cannot keep up). The
  mitigation is that a room broadcasts small fan-out frames and the runtime closes dead
  peers; a slow-consumer policy is a deployment decision, not a protocol one.
- **Broadcast is best-effort per socket.** A `send` that throws is skipped so one dead peer
  cannot fail the room; the price is that `broadcast` returns _attempted_ deliveries, not
  acknowledged ones. Applications that need acknowledgement track it themselves.
- **No cross-room, cross-region fan-out.** Two sockets in different rooms are two tags in
  one object or two objects; there is no global bus. That stays `@tsir/events`' job, and
  § 6 says so rather than implying otherwise.
- **One more shape to keep true.** If Cloudflare changes the hibernation API, `rooms.ts`
  and one test fake change together — which is exactly the surface a compile error shows.

## Alternatives considered

- **`@cloudflare/workers-types`.** Rejected above: ambient platform types in a portable
  package, and tests that need a Workers runtime to run at all.
- **`ws` + a Redis subscription per room.** A real answer for Node deployments and a new
  runtime dependency for the Workers one, which cannot use it. Deferred to `@tsir/events`.
- **Leave rooms to applications.** Rejected: the failure mode is silent in development and
  subtle in production, which is the category of problem a framework is for.
