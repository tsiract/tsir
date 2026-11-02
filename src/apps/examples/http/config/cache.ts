// config/cache.ts — named cache stores (ADR-0019).
// Each store declares its driver; the application binds the actual client.
export default {
  default: 'app',
  stores: {
    app: { driver: 'memory', ttlMs: 60_000 },
    sessions: { driver: 'memory', required: true },
  },
};
