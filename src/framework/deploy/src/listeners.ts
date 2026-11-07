/**
 * Compiles AWS event-source listeners (DPL-026).
 *
 * A controller annotated with `@OnSns`, `@OnEventBridge` or `@OnStepTask` becomes a
 * `LambdaUnit` whose handlers dispatch events to the right method by topic / detail-type /
 * task name. Controller instances are built the same DI boundary HTTP uses:
 * `resolveController` defaults to `new Controller()`, so a container can plug in.
 *
 * Every handler receives two arguments: the validated body and a `ListenerContext`. The
 * context carries the Lambda deadline signal, the function name and request id, plus the
 * source-specific envelope (SNS message id, EventBridge source, etc.) — the same shape of
 * per-invocation metadata HTTP controllers get through `ctx` (`04-http.md § 8.4`).
 *
 * The body schema on the declared `body` is the validate boundary — a message that
 * fails validation is rethrown so the platform retries (SNS) or reports a batch
 * failure (SQS), exactly as HTTP returns 400 for a bad request body.
 */

import { validate } from '@tsir/validate';
import type { AwsListenerMeta, ControllerClass, DeclaredListener } from '@tsir/router';

import { listenerNotFound } from './errors.ts';
import type { LambdaContextLike, LambdaUnit, SnsRecord } from './lambda.ts';

export interface ListenerController {
  readonly controller: ControllerClass;
  readonly listeners: readonly DeclaredListener[];
}

export interface CompileListenersOptions {
  /** Instantiate a controller. Defaults to `new Controller()`. */
  readonly resolveController?: (controller: ControllerClass) => unknown;
}

type ListenerEntry = { controller: ControllerClass; listener: DeclaredListener };

/**
 * The per-invocation context handed to every listener method, second argument after the
 * body. Mirrors the HTTP `RequestContext` so a controller that handles both routes and
 * events has the same surface.
 */
export interface ListenerContext {
  /** Aborts when the Lambda's remaining time (minus grace) expires. */
  readonly signal: AbortSignal;
  readonly functionName?: string;
  readonly awsRequestId?: string;
  /** SNS envelope, when the invocation came from an SNS notification. */
  readonly sns?: {
    readonly id: string;
    readonly topicArn: string;
    readonly subject?: string;
  };
  /** EventBridge envelope, when the invocation came from an EventBridge rule. */
  readonly eventbridge?: {
    readonly source: string;
    readonly 'detail-type': string;
    readonly time: string;
  };
}

function listenerContextFrom(
  context: LambdaContextLike,
  signal: AbortSignal,
  source:
    | { kind: 'sns'; id: string; topicArn: string; subject?: string }
    | { kind: 'eventbridge'; source: string; 'detail-type': string; time: string }
    | { kind: 'invoke' },
): ListenerContext {
  return {
    signal,
    ...(context.functionName !== undefined ? { functionName: context.functionName } : {}),
    ...(context.awsRequestId !== undefined ? { awsRequestId: context.awsRequestId } : {}),
    ...(source.kind === 'sns'
      ? {
          sns: {
            id: source.id,
            topicArn: source.topicArn,
            ...(source.subject !== undefined ? { subject: source.subject } : {}),
          },
        }
      : {}),
    ...(source.kind === 'eventbridge'
      ? {
          eventbridge: {
            source: source.source,
            'detail-type': source['detail-type'],
            time: source.time,
          },
        }
      : {}),
  };
}

/**
 * Compiles one or more listener-bearing controllers into a `LambdaUnit`.
 *
 * SNS listeners are keyed by topic; EventBridge by `detail-type`. When two listeners
 * claim the same key, the last declared wins — matching the controller-override rule
 * HTTP routes use.
 */
export function compileListeners(
  controllers: readonly ListenerController[],
  options: CompileListenersOptions = {},
): LambdaUnit {
  const resolve =
    options.resolveController ??
    ((controller: ControllerClass) => new (controller as new () => unknown)());

  const snsByTopic = new Map<string, ListenerEntry>();
  const ebByDetailType = new Map<string, ListenerEntry>();
  const tasksByName = new Map<string, ListenerEntry>();

  for (const { controller, listeners } of controllers) {
    for (const listener of listeners) {
      const meta = listener.meta;
      const entry: ListenerEntry = { controller, listener };
      if (meta.kind === 'sns' && meta.topic !== undefined) {
        snsByTopic.set(meta.topic, entry);
      } else if (meta.kind === 'eventbridge') {
        // EventBridge rules already filter by event bus + detail-type, so the Lambda
        // only needs to dispatch by `detail-type` (the event's `source` is the
        // originating service, not the bus name).
        ebByDetailType.set(meta.detailType ?? '*', entry);
      } else if (meta.kind === 'steptask' && meta.name !== undefined) {
        tasksByName.set(meta.name, entry);
      }
    }
  }

  const snsHandler =
    snsByTopic.size > 0
      ? async (
          message: {
            readonly id: string;
            readonly topicArn: string;
            readonly subject?: string;
            readonly body: unknown;
            readonly record: SnsRecord;
          },
          context: LambdaContextLike,
        ): Promise<void> => {
          const topic = topicNameFromArn(message.topicArn);
          const entry = snsByTopic.get(topic);
          if (entry === undefined) {
            throw listenerNotFound({ kind: 'sns', key: topic });
          }
          const ctx = listenerContextFrom(context, new AbortController().signal, {
            kind: 'sns',
            id: message.id,
            topicArn: message.topicArn,
            ...(message.subject !== undefined ? { subject: message.subject } : {}),
          });
          await invokeListener(entry, message.body, ctx);
        }
      : undefined;

  const eventbridgeHandler =
    ebByDetailType.size > 0
      ? async (
          event: {
            readonly source: string;
            readonly 'detail-type': string;
            readonly detail: unknown;
            readonly time: string;
            readonly signal: AbortSignal;
          },
          context: LambdaContextLike,
        ): Promise<void> => {
          const detailType = event['detail-type'] ?? '*';
          const entry = ebByDetailType.get(detailType) ?? ebByDetailType.get('*');
          if (entry === undefined) {
            throw listenerNotFound({ kind: 'eventbridge', key: detailType });
          }
          const ctx = listenerContextFrom(context, event.signal, {
            kind: 'eventbridge',
            source: event.source,
            'detail-type': event['detail-type'],
            time: event.time,
          });
          await invokeListener(entry, event.detail, ctx);
        }
      : undefined;

  const invokeHandler =
    tasksByName.size > 0
      ? async (event: unknown, context: LambdaContextLike): Promise<unknown> => {
          const onlyEntry = tasksByName.size === 1 ? tasksByName.values().next().value : undefined;
          const taskName = taskNameFrom(event, onlyEntry !== undefined);
          const entry =
            tasksByName.get(taskName) ?? (taskName === '__single__' ? onlyEntry : undefined);
          if (entry === undefined) {
            const known = [...tasksByName.keys()].sort().join(', ');
            throw listenerNotFound({
              kind: 'steptask',
              key: `${taskName} (known: ${known})`,
            });
          }
          const body = taskBodyFrom(event);
          // A direct invoke has no deadline signal from the platform envelope; the Lambda
          // context is the only source. `deadlineSignal` lives in lambda.ts and is applied
          // there before this handler runs, so we pass a never-aborting signal here.
          const ctx = listenerContextFrom(context, new AbortController().signal, {
            kind: 'invoke',
          });
          return await invokeListener(entry, body, ctx);
        }
      : undefined;

  async function invokeListener(
    entry: ListenerEntry,
    body: unknown,
    ctx: ListenerContext,
  ): Promise<unknown> {
    const instance = resolve(entry.controller) as Record<string, (...args: unknown[]) => unknown>;
    const method = entry.listener.handler;
    const fn = instance[method];
    if (typeof fn !== 'function') {
      throw listenerNotFound({ kind: 'sns', key: `${method} (not callable)` });
    }
    const validated = await validateBody(entry.listener.meta, body);
    return await fn.call(instance, validated, ctx);
  }

  return {
    unit: 'listeners',
    ...(snsHandler !== undefined ? { sns: snsHandler } : {}),
    ...(eventbridgeHandler !== undefined ? { eventbridge: eventbridgeHandler } : {}),
    ...(invokeHandler !== undefined ? { invoke: invokeHandler } : {}),
  };
}

async function validateBody(meta: AwsListenerMeta, body: unknown): Promise<unknown> {
  if (meta.body === undefined) return body;
  const result = await validate(meta.body, body);
  if (!result.ok) {
    const issue = result.issues[0];
    throw listenerNotFound({ kind: 'sns', key: `body validation: ${issue?.message ?? 'invalid'}` });
  }
  return result.value;
}

/** Strips the ARN prefix to get the topic name: `arn:aws:sns:region:account:name` → `name`. */
function topicNameFromArn(arn: string): string {
  const parts = arn.split(':');
  return parts[parts.length - 1] ?? arn;
}

/**
 * Extracts the Step Functions task name from a direct-invoke event (DPL-029).
 *
 * The event may carry `{ task: 'name', ...input }` explicitly. When there is exactly
 * one task declared, an unlabelled event is routed to it — the common case for a unit
 * that owns a single Step Functions activity.
 */
function taskNameFrom(event: unknown, singleTask: boolean): string {
  if (typeof event === 'object' && event !== null && 'task' in event) {
    const task = (event as { task?: unknown }).task;
    if (typeof task === 'string') return task;
  }
  if (singleTask) return '__single__';
  return typeof event === 'string' ? event : '__unknown__';
}

/**
 * The body passed to a `@OnStepTask` method is the event minus the routing `task` field.
 * A string event is passed through unchanged.
 */
function taskBodyFrom(event: unknown): unknown {
  if (typeof event === 'object' && event !== null && 'task' in event) {
    const { task: _task, ...rest } = event as Record<string, unknown>;
    void _task;
    return rest;
  }
  return event;
}
