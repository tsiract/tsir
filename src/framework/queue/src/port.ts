/**
 * The queue port (`§ 4.2`).
 *
 * A **connection** is a named instance of the port with one driver; a **job** is a name, a
 * payload and a policy; a **worker** is what turns reserved messages into handler calls. The
 * driver's whole job is the message lifecycle:
 *
 * ```
 * push ──▶ reserved ──▶ complete
 *            │  └────▶ fail  ──▶ (retryAt) ──▶ push
 *            └───────▶ dead  ──▶ dead-letter table ──▶ `queue:retry`
 * ```
 *
 * Delivery is **at-least-once**, always. That is not a limitation to be worked around; it is
 * the contract, and the reason `JobContext.id` is stable across retries and exists to be used
 * as an idempotency key.
 */

/** One message, as it sits in a backend. */
export interface JobMessage {
  readonly id: string;
  readonly name: string;
  /** Already serialised: a backend never inspects a payload. */
  readonly payload: string;
  /** The connection that holds it — part of the address, not a hint. */
  readonly connection: string;
  /** Attempts *started*, including the one that failed. `0` means "never run". */
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Epoch ms: not reservable before this. Also how a delayed dispatch is expressed. */
  readonly availableAt: number;
  /** Deduplication key for the backend, when it supports one. */
  readonly idempotencyKey?: string | undefined;
  /** Origin request id, for correlating a job with the request that dispatched it. */
  readonly requestId?: string | undefined;
  readonly createdAt: number;
  /** The last failure, for the dead-letter listing and logs. */
  readonly lastError?: string | undefined;
}

/** What a driver can do. Per connection, validated at boot like every other registry. */
export interface QueueCapabilities {
  /** Enqueued inside the caller's write — the outbox is then unnecessary (`sync`, `database`). */
  readonly transactional: boolean;
  /** `dispatchLater` / `schedule(at)`. */
  readonly delay: boolean;
  /** `cancel(id)`. Most brokers cannot remove a message already reserved. */
  readonly cancel: boolean;
  /** Survives a restart. False for `memory` and `sync`. */
  readonly persistent: boolean;
  /** Delivers in dispatch order per connection. False for `sqs`/Queues without a FIFO queue. */
  readonly ordered: boolean;
  /** A dead-letter store exists and `queue:retry` can replay from it. */
  readonly deadLetter: boolean;
  /**
   * The **backend** deduplicates on `idempotencyKey`. True where the store can enforce it (a
   * partial unique index, a FIFO dedupe id); false on a broker that accepts the same body twice
   * and on `sync`.
   *
   * This is the most consequential flag to get wrong, so it is not inferred from "the driver
   * takes the option": a dispatch that carries a key to a backend which ignores it looks
   * exactly like one that worked. When it is false the guarantee moves to the application —
   * `JobContext.id` is stable across retries for precisely that reason, and the conformance
   * kit refuses to pretend otherwise.
   */
  readonly idempotency: boolean;
}

export interface QueueBackend {
  readonly name: string;
  readonly capabilities: QueueCapabilities;

  push(message: JobMessage): Promise<void>;
  /**
   * Claim up to `limit` messages that are due. A claimed message becomes invisible to other
   * workers until it is completed, failed, or its lease expires.
   *
   * `attempts` on a reserved message **includes the attempt being started**: a backend that
   * returns 1 means "this is the first run". The worker uses it as the attempt number rather
   * than incrementing again, which is the only way the two can never disagree.
   */
  reserve(input: {
    readonly connection: string;
    readonly limit: number;
    readonly now: number;
    /** Lease length: a worker that dies must not hold a message forever. */
    readonly leaseMs: number;
  }): Promise<readonly JobMessage[]>;
  complete(message: JobMessage): Promise<void>;
  /** Put it back for another attempt, or into the dead-letter store when `attempts` is spent. */
  fail(
    message: JobMessage,
    input: { readonly error: string; readonly retryAt?: number | undefined },
  ): Promise<void>;
  /** Dead-letter store. Ordered oldest first; `limit` caps the read. */
  dead(limit: number): Promise<readonly JobMessage[]>;
  /** Move one dead message back onto the queue, clearing its attempts. */
  replay(id: string, now: number): Promise<boolean>;
  /** Delete one dead message. */
  discard(id: string): Promise<boolean>;
  size(): Promise<number>;
  /** Remove every message — including dead ones. Named `purge`, never used by `queue:work`. */
  purge(): Promise<void>;
  now?(): number;
}

/** A driver: a name, its capabilities, and a factory that opens one backend. */
export interface QueueDriver<Config = unknown> {
  readonly name: string;
  readonly capabilities: QueueCapabilities;
  open(config?: Config): QueueBackend;
}

/** The façade application code calls — one connection, its jobs, its policy. */
export interface Queue {
  readonly connection: string;
  readonly driver: string;
  readonly capabilities: QueueCapabilities;

  dispatch<Payload>(
    job: JobLike<Payload>,
    payload: NoInfer<Payload>,
    options?: DispatchOptions,
  ): Promise<DispatchResult>;
  /** `dispatch` for several messages; returns every id, in order. */
  dispatchMany(
    messages: readonly {
      readonly job: JobLike<unknown>;
      readonly payload: unknown;
      readonly options?: DispatchOptions;
    }[],
  ): Promise<readonly DispatchResult[]>;
  /** Not before `delayMs` — or not before `at`, which is what a scheduler passes. */
  dispatchLater<Payload>(
    job: JobLike<Payload>,
    payload: NoInfer<Payload>,
    options: DispatchOptions & { readonly delayMs: number },
  ): Promise<DispatchResult>;
  cancel(id: string): Promise<boolean>;
  size(): Promise<number>;
  dead(limit?: number): Promise<readonly JobMessage[]>;
  retry(id: string): Promise<boolean>;
  discard(id: string): Promise<boolean>;
  purge(): Promise<void>;
}

/** The structural slice of a job definition a dispatcher needs. */
export interface JobLike<Payload> {
  readonly name: string;
  readonly connection?: string | undefined;
  readonly maxAttempts?: number | undefined;
  /** Typed so a wrong payload is a compile error at the dispatch site. */
  readonly __payload?: Payload | undefined;
}

export interface DispatchOptions {
  /** Overrides the job's own connection. Still checked against the registry. */
  readonly connection?: string | undefined;
  readonly maxAttempts?: number | undefined;
  /** Deduplication: two dispatches with one key cannot both be delivered. */
  readonly idempotencyKey?: string | undefined;
  readonly delayMs?: number | undefined;
  /** Origin request id — pass `ctx.id` from an HTTP handler to correlate the job. */
  readonly requestId?: string | undefined;
}

export interface DispatchResult {
  readonly id: string;
  readonly connection: string;
  readonly name: string;
  /** False when the backend dropped it as a duplicate of `idempotencyKey`. */
  readonly accepted: boolean;
}
