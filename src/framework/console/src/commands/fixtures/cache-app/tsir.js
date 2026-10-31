// The cache fixture (`CACHE-9`, `CACHE-10`): two stores, both usable with no services.
//
// `app` is the default with a store-level TTL; `sessions` is a second store on the same
// driver, which is the normal case the registry exists for (ADR-0019 § 2). A `database` or
// `redis` store would need a client only the application can supply, which is exactly why
// this fixture does not declare one — the commands must work without one.
export default {
  app: {
    name: 'cache-app',
    entry: './src/app.ts',
  },
  cache: {
    default: 'app',
    stores: {
      app: { driver: 'memory', ttlMs: 60000 },
      sessions: { driver: 'memory', required: true },
    },
  },
};
