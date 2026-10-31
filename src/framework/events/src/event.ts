/**
 * Events and listeners (`§ 4.5`).
 *
 * An **event** is a name that travels and a payload type that does not: `order.placed` is what
 * a broker, a log line and an outbox row all agree on, and the payload is JSON. A **listener**
 * is a named handler for one event, declared once, with its delivery mode written down.
 *
 * The rule this file exists to make unavoidable:
 *
 * > **Sync vs async is declared, never inferred.** A listener is `sync` (it runs inside the
 * > caller's flow, and its failure reaches the caller) or `queued` (it becomes a job and runs in
 * > a worker, on the connection it names). Nothing guesses from the presence of `await`, from a
 * > config switch, or from how slow the handler looks.
 *
 * Why the distinction is worth a required field: the two have different failure modes, different
 * latency, and different owners. A receipt mail that silently became a job is a support ticket
 * ("the customer says it was never sent"); a stock reservation that silently ran inline is a
 * transaction held open on a network call. Both are cheap to prevent at the declaration and
 * expensive to notice in production.
 */

/** How a listener runs. Declared per listener; the event carries the project default. */
export type EventMode = 'sync' | 'queued';

export interface EventDefinition<Payload> {
  /** Dotted, stable, and part of the public contract: `order.placed`, not `OrderPlaced`. */
  readonly name: string;
  /** The delivery mode for listeners that do not name one. Default `queued`. */
  readonly mode: EventMode;
  readonly description?: string | undefined;
  /**
   * Never set. It exists so `EventDefinition<Payload>` is invariant in `Payload`: a listener
   * declared for `OrderPlaced` cannot be handed to a bus that only knows `OrderCancelled`.
   */
  readonly payloadType?: Payload | undefined;
}

/**
 * Declare an event.
 *
 * The name is checked here rather than at dispatch: a name with a space or an uppercase letter
 * becomes a job name, a log field and an outbox row, and fixing it after a release means a
 * migration.
 */
export function defineEvent<Payload>(
  input: Omit<EventDefinition<Payload>, 'mode' | 'payloadType'> & { readonly mode?: EventMode },
): EventDefinition<Payload> {
  if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/u.test(input.name)) {
    throw new TypeError(
      `event name "${input.name}" is not a dotted lowercase name — use \`order.placed\`, ` +
        'because the name is what a broker, a log line and an outbox row all carry',
    );
  }
  return {
    name: input.name,
    mode: input.mode ?? 'queued',
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}

/** What a listener receives. */
export interface EventContext<Payload> {
  readonly event: EventDefinition<Payload>;
  /** Which listener is running — the log line and the metrics label. */
  readonly listener: string;
  /**
   * Stable across retries and across a relay republish: the outbox row id when the delivery came
   * through the outbox, the job id otherwise. Use it as the idempotency key.
   */
  readonly id: string;
  readonly payload: Payload;
  /** When the event was dispatched, not when this listener started. */
  readonly occurredAt: number;
  /** 1 on the first run. `sync` listeners always see 1 — there is nothing to retry. */
  readonly attempt: number;
  readonly signal: AbortSignal;
  log(message: string): void;
}

export interface ListenerDefinition<Payload> {
  /** The event this listener answers. The token, not its name, so a typo cannot cross events. */
  readonly event: EventDefinition<Payload>;
  /** Unique within the event. Part of the derived job name, so renaming it renames a job. */
  readonly name: string;
  /** Overrides the event's default. */
  readonly mode?: EventMode | undefined;
  handle(context: EventContext<Payload>): Promise<void> | void;
  /** `queued` only: which queue connection the job goes to. */
  readonly connection?: string | undefined;
  /** `queued` only: total attempts, first run included. The worker's default otherwise. */
  readonly maxAttempts?: number | undefined;
  /** `queued` only: `false` sends a failed attempt straight to the dead-letter table. */
  readonly retryable?: boolean | undefined;
  readonly description?: string | undefined;
}

export function defineListener<Payload>(
  event: EventDefinition<Payload>,
  definition: Omit<ListenerDefinition<Payload>, 'event'>,
): ListenerDefinition<Payload> {
  if (definition.name === '' || /[\s:]/u.test(definition.name)) {
    throw new TypeError(
      `listener name "${definition.name}" must be non-empty and contain no whitespace or ":" — ` +
        'it becomes the second half of the job name',
    );
  }
  return { event, ...definition };
}

/**
 * The job name a `queued` delivery runs under: `event:order.placed:send-receipt`.
 *
 * It is derived, not configured, and that is deliberate: a job name is what a worker looks up,
 * what `queue:failed` prints and what an operator retries. Two of them for one listener is a
 * failure that only shows up in production, when a retry goes to a name nobody registered.
 */
export function deliveryJobName(event: EventDefinition<unknown>, listener: string): string {
  return `event:${event.name}:${listener}`;
}

/** The payload a delivery job carries. JSON, so it holds no references — by design. */
export interface DeliveryEnvelope {
  readonly event: string;
  readonly listener: string;
  /** The event's payload, already JSON-safe. */
  readonly payload: unknown;
  /** When the event happened; `when` the delivery runs is the queue's business. */
  readonly occurredAt: number;
  /** The dispatch id — the same id for every listener of one dispatch, plus the listener name. */
  readonly dispatchId: string;
}

/** The mode a listener actually runs in, after the event's default is applied. */
export function modeOf(listener: ListenerDefinition<unknown>): EventMode {
  return listener.mode ?? listener.event.mode;
}
