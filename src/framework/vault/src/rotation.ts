/**
 * Rotation: rewriting every encrypted value onto the active key (`VLT-019`…`VLT-024`).
 *
 * ## Why this is a port and not a script
 *
 * `@tsir/vault` has no database dependency — deliberately (see `codec.ts` in
 * `@tsir/database`: the arrow points database → vault, never back). So the runner
 * deals in **rows and batches**, and the SQL lives where SQL already lives. Two
 * consequences worth stating:
 *
 * - the engine is testable without a database, which is the only way the
 *   resume-after-kill and double-write cases get exercised on every save;
 * - an application that wants rotation in a job (not the CLI) reuses exactly what
 *   the CLI uses, instead of a second implementation.
 *
 * ## The rules the engine enforces
 *
 * 1. **Idempotent.** A row whose envelope already names the active key is skipped
 *    without decrypting it. Running twice is a no-op, and a run that was killed
 *    half-way resumes into the same no-op for the part that finished.
 * 2. **Watermark, not offsets.** Each batch selects `key > watermark ORDER BY key`,
 *    so a row inserted or deleted mid-run cannot shift the window and make a row
 *    invisible (the classic `OFFSET` bug in a table that is still being written).
 * 3. **Failures do not stop the run, and do not disappear.** A row that cannot be
 *    decrypted (moved column, corrupted value, missing key) is counted, sampled and
 *    left alone; the next run retries it, and `remaining` keeps the exit code honest.
 * 4. **One runner per target.** The lock is the store's job (an advisory lock on
 *    Postgres); the engine only reports `locked` instead of pretending it rotated.
 */

import type { Vault } from './cipher.ts';
import { parseEnvelope, looksLikeEnvelope } from './envelope.ts';

/** Table name the store creates; exported so DDL and reports cannot drift apart. */
export const ROTATION_LEDGER = '__tsir_vault_rotation';

/** One `(table, column)` to re-encrypt. `keyColumn` is the watermark's primary key. */
export interface RotationTarget {
  readonly table: string;
  readonly column: string;
  readonly keyColumn: string;
}

/** A row as the store returns it: the watermark value and the stored envelope. */
export interface RotationRow {
  readonly key: string;
  readonly value: string;
}

/**
 * The work a locked session can do.
 *
 * Split from `RotationStore` because a session-scoped lock (Postgres advisory
 * locks) has to be *held* for as long as rows are being rewritten: acquiring it on
 * one pooled connection and rewriting through another is not a lock at all. The
 * store therefore owns the scope, and the engine only ever sees this narrower type.
 */
export interface RotationScope {
  /** Rows whose value does not name `activeKeyId`, after `after`, ordered by key. */
  batch(
    activeKeyId: string,
    after: string | undefined,
    limit: number,
  ): Promise<readonly RotationRow[]>;
  /** Rewrites one value and records it in the ledger. Idempotent and atomic. */
  commit(row: RotationRow, rewritten: string): Promise<void>;
}

/**
 * What the engine needs from storage.
 *
 * `withLock` is the whole contract for a target: it holds the exclusive lock for the
 * duration of `run`, hands over a scope bound to that session, and releases on the
 * way out — including on throw and on abort. It throws `VLT_ROTATION_LOCKED` when
 * another runner already holds the target.
 *
 * `commit` must be atomic per row — rewrite the value *and* record the ledger row —
 * because a crash between the two is exactly the state the ledger exists to make
 * impossible.
 */
export interface RotationStore {
  /** Creates the ledger table when it is missing. Called once per run. */
  ensureLedger(): Promise<void>;
  /** Runs `run` while holding the per-target lock. */
  withLock<T>(target: RotationTarget, run: (scope: RotationScope) => Promise<T>): Promise<T>;
  /** How many rows still do not name `activeKeyId` — the number `retire` must see as 0. */
  remaining(target: RotationTarget, activeKeyId: string): Promise<number>;
}

export interface RotationFailure {
  readonly target: string;
  readonly key: string;
  readonly code: string;
  readonly message: string;
}

export interface RotationTargetProgress {
  readonly target: RotationTarget;
  readonly rotated: number;
  readonly failed: number;
  readonly remaining: number;
  /** Another runner held the lock; nothing was attempted. */
  readonly locked: boolean;
  /** Stopped early because the caller aborted. */
  readonly aborted: boolean;
  /** A store error that stopped this target (not a per-row failure). */
  readonly error?: string | undefined;
}

export interface RotationReport {
  readonly targets: readonly RotationTargetProgress[];
  readonly rotated: number;
  readonly failed: number;
  readonly remaining: number;
  readonly elapsedMs: number;
  /** Measured, never estimated: rows actually written divided by wall time. */
  readonly rowsPerSecond: number;
  /** `remaining / rowsPerSecond`, or `undefined` when nothing has been measured. */
  readonly etaMs: number | undefined;
  readonly failures: readonly RotationFailure[];
}

/**
 * The metric names this engine emits (`VLT-023`).
 *
 * Spelled out rather than assembled from a prefix so a dashboard and a test can
 * grep for them. The `{table,column}` label pair is the same identity the AAD
 * binds: one series per encrypted column, never per row.
 */
export const ROTATION_METRICS = {
  /** Rows successfully re-encrypted, counted once per committed row. */
  rows: 'vault_rotation_rows_total',
  /** Rows that failed, labelled with the error code. */
  errors: 'vault_rotation_errors_total',
  /** Rows still on an old key, sampled after each target finishes. */
  remaining: 'vault_rotation_remaining',
} as const;

/**
 * Where rotation reports numbers (`VLT-023`).
 *
 * Structural and optional: `@tsir/telemetry` (phase 8) satisfies it, and so does a
 * five-line test double. The engine never imports a metrics library — the same
 * reason the SQL lives in `@tsir/database` and not here.
 */
export interface RotationObserver {
  counter(name: string, value: number, labels: Readonly<Record<string, string>>): void;
  gauge?(name: string, value: number, labels: Readonly<Record<string, string>>): void;
}

export interface RotationOptions {
  readonly vault: Vault;
  readonly store: RotationStore;
  readonly targets: readonly RotationTarget[];
  /** Rows per statement round trip. Default 500 — small enough to keep locks short. */
  readonly batchSize?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Clock for the elapsed-time report (CFG-011). Default `Date.now`; tests fix it. */
  readonly now?: (() => number) | undefined;
  /** Called after every batch; the hook `vault:rotate` uses for progress output. */
  readonly onBatch?: ((progress: RotationTargetProgress) => void) | undefined;
  /** Distinct failures kept for reporting. Default 20. */
  readonly maxFailureSamples?: number | undefined;
  /** Metrics sink. Never allowed to fail the rotation — see `report()`. */
  readonly observer?: RotationObserver | undefined;
}

const DEFAULT_BATCH = 500;
const DEFAULT_FAILURE_SAMPLES = 20;

function coded(reason: unknown): { code: string; message: string } {
  const error = reason as { code?: unknown; message?: unknown };
  return {
    code: typeof error?.code === 'string' ? error.code : 'VLT_ROTATION_FAILED',
    message: typeof error?.message === 'string' ? error.message : String(reason),
  };
}

/** Labels every metric carries: the same pair the AAD binds. */
function labelsOf(target: RotationTarget): Readonly<Record<string, string>> {
  return { table: target.table, column: target.column };
}

/**
 * Emits a metric and swallows whatever the sink does with it.
 *
 * Telemetry is never allowed to break the work it observes: a counter that throws
 * (a full buffer, a bad config) would otherwise turn a successful rotation into a
 * failed one, and the rows would be exactly as rotated as before.
 */
function report(
  observer: RotationObserver | undefined,
  emit: (sink: RotationObserver) => void,
): void {
  if (observer === undefined) return;
  try {
    emit(observer);
  } catch {
    // Deliberately ignored — see above.
  }
}

/**
 * Re-encrypts every value that is not on the active key.
 *
 * Never throws for a per-row problem or a held lock: both are data the caller needs
 * (`failed`, `locked`), and a rotation that aborts on the first unreadable row is a
 * rotation nobody can finish. A programming error in the store still propagates.
 */
export async function runRotation(options: RotationOptions): Promise<RotationReport> {
  const { vault } = options;
  const limit = options.batchSize ?? DEFAULT_BATCH;
  const maxSamples = options.maxFailureSamples ?? DEFAULT_FAILURE_SAMPLES;
  const now = options.now ?? ((): number => Date.now());
  const startedAt = now();
  // A function rather than an inline expression: TypeScript narrows `signal?.aborted`
  // after the first comparison, and the second check would be flagged as unreachable
  // even though the signal can flip between batches.
  const stopped = (): boolean => options.signal?.aborted === true;

  await options.store.ensureLedger();

  const targets: RotationTargetProgress[] = [];
  const failures: RotationFailure[] = [];
  let rotatedAll = 0;

  for (const target of options.targets) {
    /** The column identity the AAD binds — table and column, never the key column. */
    const column = { table: target.table, column: target.column };

    let rotated = 0;
    let failed = 0;
    let locked = false;
    let aborted = false;
    let error: string | undefined;

    const outcome = await options.store
      .withLock(target, async (scope) => {
        let watermark: string | undefined;
        for (;;) {
          if (stopped()) return { rotated, failed, aborted: true };

          const rows = await scope.batch(vault.activeKeyId, watermark, limit);
          if (rows.length === 0) break;

          for (const row of rows) {
            if (stopped()) {
              aborted = true;
              break;
            }

            // Idempotence: someone else (a previous run, or a concurrent writer)
            // may have already moved this row onto the active key.
            if (looksLikeEnvelope(row.value)) {
              const envelope = parseEnvelope(row.value);
              if (envelope.keyId === vault.activeKeyId) continue;
            }

            try {
              const plaintext = await vault.decrypt(column, row.value);
              const rewritten = await vault.encrypt(column, plaintext);
              await scope.commit(row, rewritten);
              rotated += 1;
              rotatedAll += 1;
              report(options.observer, (sink) =>
                sink.counter(ROTATION_METRICS.rows, 1, labelsOf(target)),
              );
            } catch (reason: unknown) {
              failed += 1;
              const shape = coded(reason);
              report(options.observer, (sink) =>
                sink.counter(ROTATION_METRICS.errors, 1, {
                  ...labelsOf(target),
                  code: shape.code,
                }),
              );
              if (failures.length < maxSamples) {
                failures.push({
                  target: `${target.table}.${target.column}`,
                  key: row.key,
                  code: shape.code,
                  message: shape.message,
                });
              }
            }
          }

          watermark = rows[rows.length - 1]?.key;
          options.onBatch?.({ target, rotated, failed, remaining: -1, locked: false, aborted });
          if (aborted) break;
          if (rows.length < limit) break;
        }

        return { rotated, failed, aborted };
      })
      .catch((reason: unknown) => {
        const shape = coded(reason);
        // A held lock is reported, not thrown: the CLI turns it into an exit code,
        // and a multi-target run should still finish the targets nobody else owns.
        if (shape.code === 'VLT_ROTATION_LOCKED') locked = true;
        else error = shape.message;
        return { rotated, failed, aborted };
      });

    rotated = outcome.rotated;
    failed = outcome.failed;
    aborted = outcome.aborted;

    const remaining = around(await options.store.remaining(target, vault.activeKeyId));
    report(options.observer, (sink) =>
      sink.gauge?.(ROTATION_METRICS.remaining, Math.max(0, remaining), labelsOf(target)),
    );
    targets.push({ target, rotated, failed, remaining, locked, aborted, error });
  }

  const elapsedMs = Math.max(1, now() - startedAt);
  const remaining = targets.reduce((total, entry) => total + Math.max(0, entry.remaining), 0);
  const rowsPerSecond = rotatedAll === 0 ? 0 : (rotatedAll * 1000) / elapsedMs;

  return {
    targets,
    rotated: rotatedAll,
    failed: targets.reduce((total, entry) => total + entry.failed, 0),
    remaining,
    elapsedMs,
    rowsPerSecond,
    etaMs: rowsPerSecond === 0 ? undefined : (remaining / rowsPerSecond) * 1000,
    failures,
  };
}

/** `remaining` is allowed to be unknown (`-1`) only when the lock was held. */
function around(value: number): number {
  return Number.isFinite(value) ? value : -1;
}

export interface RotationStatusEntry extends RotationTargetProgress {
  /** Share of the target already on the active key, 0–1. `undefined` when unknown. */
  readonly percent: number | undefined;
}

export interface RotationStatus {
  readonly activeKeyId: string;
  readonly targets: readonly RotationStatusEntry[];
  readonly remaining: number;
}

/**
 * `vault:rotate:status` — what is left, per target (`VLT-022`).
 *
 * Reads the store and never writes: a status command that repaired something would
 * be a second implementation of the runner.
 */
export async function rotationStatus(options: {
  readonly store: RotationStore;
  readonly targets: readonly RotationTarget[];
  readonly activeKeyId: string;
}): Promise<RotationStatus> {
  const entries: RotationStatusEntry[] = [];
  let remaining = 0;

  for (const target of options.targets) {
    const left = around(await options.store.remaining(target, options.activeKeyId));
    remaining += Math.max(0, left);
    entries.push({
      target,
      rotated: 0,
      failed: 0,
      remaining: left,
      locked: false,
      aborted: false,
      // Without a total row count there is no honest percentage; the CLI prints the
      // remaining count instead of inventing a denominator.
      percent: undefined,
    });
  }

  return { activeKeyId: options.activeKeyId, targets: entries, remaining };
}
