// config/queue.ts — the queue connection registry.
//
// The default driver is `database` so jobs are persisted in the `queue_jobs`
// table and visible in the Horizon-style queue dashboard. In-memory (`memory`)
// is available for tests that do not need persistence.
export default {
  default: 'database',
  connections: {
    // A durable queue backed by the default database connection. Jobs live in
    // `queue_jobs` (pending/running/delayed) and `queue_dead` (failed).
    database: { driver: 'database', connection: 'primary', table: 'queue_jobs' },
    memory: { driver: 'memory' },
  },
};
