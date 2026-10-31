/**
 * `@tsir/pulse` error codes (append-only).
 *
 * Three rules, from
 *
 * · **A logger never fails a request.** Sink and exporter problems are reported, counted and
 * swallowed — a telemetry bug that turns a 200 into a 500 is worse than no telemetry.
 * · **Misconfiguration is a boot error.** An unknown level or format is `PULSE_CONFIG_INVALID` at
 * `createLogger`, not a surprise at 3 a.m.
 * · **Redaction refuses rather than guesses.** If a pattern throws, the field becomes
 * `"[redaction-error]"` and the failure is reported — never logged unredacted.
 */

import { TsirError } from '@tsir/container';

export type PulseErrorCode =
  'PULSE_CONFIG_INVALID' | 'PULSE_SINK_FAILED' | 'PULSE_REDACTION_FAILED' | 'PULSE_METRIC_INVALID';

const KIND = 'capability';

export function configInvalid(problem: string): TsirError {
  return new TsirError('PULSE_CONFIG_INVALID', `pulse config is invalid: ${problem}`, {
    kind: KIND,
    hint: 'the logger, redactor and sinks are validated when they are built, so a bad level or format fails at boot instead of at the first request',
  });
}

export function sinkFailed(name: string, detail: string): TsirError {
  return new TsirError('PULSE_SINK_FAILED', `log sink "${name}" failed: ${detail}`, {
    kind: KIND,
    hint: 'fail-open by default: the sink is disabled for the rest of the invocation, reported once, and the request is unaffected — `required: true` is the only way to invert that, and it fails readiness, not requests',
    context: { sink: name },
  });
}

export function redactionFailed(path: string, detail: string): TsirError {
  return new TsirError('PULSE_REDACTION_FAILED', `redaction failed at "${path}": ${detail}`, {
    kind: KIND,
    hint: 'the field is replaced with "[redaction-error]" — a redaction bug must never be the reason a secret is written',
    context: { path },
  });
}

export function metricInvalid(problem: string): TsirError {
  return new TsirError('PULSE_METRIC_INVALID', `metric is invalid: ${problem}`, {
    kind: KIND,
    hint: 'metric names are `snake_case` with a unit suffix (`_total`, `_ms`, `_bytes`), and labels are low-cardinality by construction',
  });
}
