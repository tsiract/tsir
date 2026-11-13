// config/cache.ts — the cache store registry.
//
// `memory` is the default driver so the app boots without Redis or KV. Swap to
// `database` (table `cache_entries`) or `cloudflare-kv` in production and set
// `required: true` on stores that must not silently degrade.
//
// Stores are named, so a request can only reach a store that was declared here.
export default {
  default: 'memory',
  stores: {
    memory: { driver: 'memory' },
    // A durable store backed by the default database connection. Uncomment and
    // run `tsir cache:table` to create the `cache_entries` table when moving to
    // production.
    // database: { driver: 'database', connection: 'primary', table: 'cache_entries' },
  },
};
