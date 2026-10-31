/**
 * The log-volume limiter (`OBS-009`).
 *
 * A retry storm, a loop that logs per row, or a failing dependency hit once per request all produce
 * the same outcome: a log bill that arrives before the incident report does, and a dashboard that
 * cannot be read because the interesting line is one of 4 million identical ones.
 *
 * The rule is one line of policy: **per event name, per second**, admit up to `perSecond` records.
 * Everything above the limit is dropped and counted, and `drain` reports the counts so the logger
 * can write **one** summary record per window instead of the flood. Dropping is per name, so a noisy
 * event cannot silence a quiet one.
 *
 * Why a fixed one-second window and not a token bucket: the summary line says "1 000 per second", and
 * a fixed window makes that sentence true. A bucket would smooth the rate and make the summary a lie
 * about what was actually dropped.
 */

export interface DroppedCount {
  readonly event: string;
  readonly dropped: number;
}

export interface RateLimiter {
  /** True when the record may be written now; false when it was dropped and counted. */
  admit(event: string, at: number): boolean;
  /** The dropped counts since the last drain, then clears them. */
  drain(): readonly DroppedCount[];
  /** How many records are waiting to be reported. Checked without clearing, by the summary logic. */
  readonly pending: number;
  /** How many records have been dropped in total. Exposed as a metric, and asserted in tests. */
  readonly totalDropped: number;
}

export interface RateLimitOptions {
  /** Records per event per second. Default 1 000 — high enough for production, low enough to stop a loop. */
  readonly perSecond?: number | undefined;
  /** Events exempt from the limit: `pulse.log.dropped` itself must never be dropped. */
  readonly exempt?: readonly string[] | undefined;
}

const DEFAULT_PER_SECOND = 1_000;

export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const perSecond = Math.max(1, Math.floor(options.perSecond ?? DEFAULT_PER_SECOND));
  const exempt = new Set(options.exempt ?? []);

  const windows = new Map<string, { second: number; count: number }>();
  const dropped = new Map<string, number>();
  let totalDropped = 0;

  return {
    get totalDropped() {
      return totalDropped;
    },
    get pending() {
      let total = 0;
      for (const count of dropped.values()) total += count;
      return total;
    },

    admit(event, at) {
      if (exempt.has(event)) return true;

      const second = Math.floor(at / 1_000);
      const window = windows.get(event);
      if (window === undefined || window.second !== second) {
        windows.set(event, { second, count: 1 });
        return true;
      }
      if (window.count >= perSecond) {
        window.count += 1;
        dropped.set(event, (dropped.get(event) ?? 0) + 1);
        totalDropped += 1;
        return false;
      }
      window.count += 1;
      return true;
    },

    drain() {
      const counts = [...dropped.entries()].map(([event, count]) => ({ event, dropped: count }));
      dropped.clear();
      return counts;
    },
  };
}
