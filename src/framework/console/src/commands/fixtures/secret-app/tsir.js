// The migrate fixture (`DPL-021`): one journaled connection, and therefore one migrate unit.
//
// A migrate unit is a *script*, not a function — it has to run once, before the new code
// takes traffic, and never on cold start. The graph gets it from this declaration alone.
export default {
  app: {
    name: 'secret-app',
    entry: './src/app.ts',
  },
  database: {
    default: 'primary',
    connections: {
      primary: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } },
      // No journal, so no unit: a read replica must not gate a release (ADR-0019).
      analytics: { driver: 'postgres', url: { fromEnv: 'ANALYTICS_URL' }, journal: false },
    },
  },
  deploy: {
    targets: {
      cloudflare: { bindings: {} },
    },
  },
};
