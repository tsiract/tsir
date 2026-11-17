// config/auth.ts — where sessions and API keys live.
//
// `CAP-018`: both stores were constructors the modules wired by hand, so `tsir.js` could not select
// them and `tsir doctor` could not report which store a deployment used. The app happened to pick
// `database` — but nothing was keeping that true, and `memorySessionStore` would have compiled.
//
// `database` keeps sessions and keys in the same D1 database as the rest of the app's state, so a
// deploy does not log everyone out and a key issued on one Worker is accepted by every Worker.
// `tsir migrate` creates both tables (`tsir_sessions`, `tsir_api_keys`).
export default {
  sessions: {
    store: { driver: 'database', table: 'tsir_sessions' },
  },
  apiKeys: {
    store: { driver: 'database', table: 'tsir_api_keys' },
  },
};
