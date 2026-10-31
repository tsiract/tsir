// The queue fixture's configuration (`CAP-004`).
//
// Two connections on purpose: `default` is the file-backed one the entry exports, and `local`
// exists only here, on the `sync` driver, so a test can prove that `queue:work --connection=local`
// refuses instead of polling a store that never has anything in it.
export default {
  app: {
    name: 'queue-app',
    entry: './src/app.ts',
  },
  queue: {
    default: 'default',
    connections: {
      default: { driver: 'memory' },
      local: { driver: 'sync' },
    },
  },
};
