import { defineCommand } from '../../../../define-command.ts';
// The app exports its cache registry, the same way it exports `database` (ADR-0019).
import { cachesFromConfig } from '@tsir/cache';
import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';

export const spec = defineConfig({});

export default defineApp({
  name: 'cache-app',
  config: spec,
  modules: [],
});

export const caches = cachesFromConfig({
  cache: {
    default: 'app',
    stores: {
      app: { driver: 'memory', ttlMs: 60_000 },
      sessions: { driver: 'memory', required: true },
    },
  },
});

export const handler = (): Response => new Response('ok');

// CLI-019: the project's own commands. `ping` is listed in tsir.js; `secret` is not, so `ract` refuses it.
export const commands = [
  defineCommand({
    name: 'ping',
    summary: 'answer pong',
    async run(argv: readonly string[]): Promise<number> {
      process.stdout.write(`pong ${String(argv.length)}\n`);
      return 0;
    },
  }),
  defineCommand({
    name: 'secret',
    summary: 'not listed in console.commands',
    async run(): Promise<number> {
      return 0;
    },
  }),
];
