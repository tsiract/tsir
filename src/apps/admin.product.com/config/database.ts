// config/database.ts — the database registry.
//
// D1 is the engine (Cloudflare's SQLite). The binding name is `DB`; it is
// injected by the Cloudflare runtime into each Worker's `env`, and locally by
// `wrangler dev` (which backs it with a SQLite file). There is no URL and no
// pool — a D1 binding is the connection.
//
// `journal: false` because D1 has no migration script: schema changes are
// applied with `wrangler d1 migrations apply`, not via a migrate unit.
export default {
  default: 'primary',
  connections: {
    primary: {
      driver: 'd1',
      binding: 'DB',
      journal: false,
    },
  },
};
