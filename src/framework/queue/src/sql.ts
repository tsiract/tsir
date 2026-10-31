/**
 * The SQL shape a queue/outbox driver needs (`ADR-0027 § 1`, reused from `@tsir/cache`).
 *
 * Structural, so `@tsir/database`'s `Database` satisfies it without `@tsir/queue` depending on
 * it — the same decision the cache package made, for the same reason: a driver that can only
 * be tested against a running server is a driver nobody tests.
 */

export interface QueueSqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface QueueSqlResult {
  readonly rows: readonly unknown[];
  readonly changes: number;
}

export interface QueueSql {
  readonly capabilities: {
    readonly engine: 'd1' | 'postgres';
    readonly placeholder: 'question' | 'dollar';
    /** `SELECT … FOR UPDATE SKIP LOCKED` exists. False on D1, which has no row locks. */
    readonly skipLocked?: boolean | undefined;
  };
  query(statement: QueueSqlStatement): Promise<QueueSqlResult>;
  /** Multi-statement atomicity — what makes the outbox possible on D1 (`§ 4.2`). */
  batch?(statements: readonly QueueSqlStatement[]): Promise<readonly QueueSqlResult[]>;
}
