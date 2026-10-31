// An app with a database and a journal. The `database` export is what the generated migrate
// script calls `migrate()` against — the same instance the app uses (ADR-0009).

import { defineApp } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';

import { emptyState, fakePgDatabase } from '../../../../../../migrate/src/fake.test-support.ts';

export const spec = defineConfig({ DATABASE_URL: env.secret() });

export default defineApp({
  name: 'secret-app',
  config: spec,
  modules: [],
});

/** Stands in for `createDatabase({ driver: createPostgresDriver({ client }) })`. */
export const database = fakePgDatabase(emptyState());

export const handler = (): Response => new Response('ok');
