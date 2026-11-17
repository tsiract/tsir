-- Feature flags.
--
-- `@tsir/pennant`'s `database` store is the only one that survives a deploy: `memoryStore` is a
-- `Map` in one process, so a Worker or a Lambda loses every rollout between requests.
--
-- The DDL mirrors `featureTableDdl({ engine: 'sqlite' })` from `@tsir/pennant`.
--
-- `rule` is TEXT, not JSON: D1 and SQLite have no JSON column type, and storing a serialised
-- `FeatureRule` keeps the three engines that do agree with each other.

CREATE TABLE IF NOT EXISTS features (
  name         TEXT PRIMARY KEY,
  description  TEXT,
  rule         TEXT NOT NULL
);
