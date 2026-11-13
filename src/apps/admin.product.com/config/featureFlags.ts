// config/featureFlags.ts — the feature-flag registry.
//
// `CAP-006`: flags used to be a constructor the app's entry wired by hand, and this app wired a
// `memoryStore` — a `Map` in one process. In production every rollout reset on the next deploy, and
// two instances disagreed about who was in an experiment. Nothing threw, so nothing said so.
//
// The `database` store keeps flags in the `features` table (`tsir migrate` creates it), which is
// where the rest of this app's state already is. The `defaults` a `memory` store would start with
// live in the app's pennant module, so there is one seed list rather than two.
export default {
  default: 'main',
  stores: {
    main: {
      driver: 'database',
      table: 'features',
    },
  },
};
