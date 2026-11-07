/**
 * Compiles the Svelte 5 frontend into a single JavaScript file served by the
 * tasks controller. Run with `bun run build:client.ts`.
 */
/* eslint-disable no-console */
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir;
const source = readFileSync(join(root, 'src', 'App.svelte'), 'utf8');
const compiled = compile(source, {
  filename: 'App.svelte',
  generate: 'client',
});

mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'app.js'), compiled.js.code);
console.log(`Compiled App.svelte → public/app.js (${compiled.js.code.length} bytes)`);
