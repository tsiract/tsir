/**
 * `make verify-templates` — install, typecheck and build every shipped frontend template.
 *
 * The templates are emitted by `src/tools/frontend-templates.ts` and asserted there for their *shape*:
 * a private manifest, no `@tsir/*` dependency, a pinned version, one router. Shape is not the thing
 * that breaks. What breaks is a version that no longer resolves, a tsconfig flag a template needs and
 * does not set, or a Vite plugin whose API moved — and every one of those is invisible until someone
 * runs `bun install && bun run build` in a directory the generator wrote.
 *
 * That was done by hand four times while the templates were being built, and each time it found a
 * real defect (a missing `jsx` flag, an unsubstituted router import, a missing
 * `allowImportingTsExtensions`). A check that only a human performs is a check that stops happening,
 * so this one is a target.
 *
 * It is **not** part of `make check`: it needs a package registry, and `make check` has to pass
 * offline. `make verify-templates` is what CI runs after `make release-pack`, which is where the
 * network is already in use.
 *
 *   bun src/tools/verify-templates.ts            # every configured template
 *   bun src/tools/verify-templates.ts --keep     # keep the work directory for inspection
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emitFrontendTemplates, type FrontendIntegration } from './frontend-templates.ts';

const ROOT = join(import.meta.dir, '..', '..');
const CONFIG = join(ROOT, 'tsir.dist.config.json');

/** Separates the phases of one template's run, so a failure says which phase broke. */
export type Phase = 'install' | 'typecheck' | 'build';

export interface TemplateFailure {
  readonly framework: string;
  readonly phase: Phase;
  readonly detail: string;
}

export interface TemplateResult {
  readonly framework: string;
  readonly bytes: number;
  readonly files: number;
}

interface JsonConfig {
  readonly frontends?: readonly FrontendIntegration[];
}

/** The integrations the distribution is configured to ship. */
export function configuredTemplates(source: string): readonly FrontendIntegration[] {
  const parsed = JSON.parse(source) as JsonConfig;
  return parsed.frontends ?? [];
}

/** The script name that typechecks a template, per framework. */
export function typecheckScript(framework: string): string {
  // Vue's own SFC compiler is the only thing that understands `<template>`, so Vue types through
  // `vue-tsc`. Every other framework is plain `tsc` over the emitted `.ts`/`.svelte` files.
  return framework === 'vue' ? 'vue-tsc --noEmit' : 'tsc --noEmit';
}

/** The output directory `vite build` writes, as a template's README promises. */
export const BUILD_DIR = 'dist';

/** The runtime to drive the templates with — the same one `make` uses, not a second guess. */
const BUN = process.env['BUN'] ?? 'bun';

/** Streams the step so CI has a log even when the step fails; returns the exit code. */
function step(name: string, argv: readonly string[], cwd: string): number {
  process.stdout.write(`    $ ${argv.join(' ')}  (${name})\n`);
  const result = Bun.spawnSync([...argv], { cwd, stdout: 'inherit', stderr: 'inherit' });
  return result.exitCode;
}

function run(argv: readonly string[], cwd: string): { code: number; output: string } {
  const result = Bun.spawnSync([...argv], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

/**
 * Installs, typechecks and builds one already-emitted template directory.
 *
 * Returns the failures rather than throwing: a template that fails must not hide the state of the
 * others, and the caller prints one line per template either way.
 */
export async function verifyTemplate(
  directory: string,
  framework: string,
): Promise<{ readonly failures: readonly TemplateFailure[]; readonly result?: TemplateResult }> {
  const failures: TemplateFailure[] = [];
  const typecheck = typecheckScript(framework);

  // Streamed rather than captured. The captured form was written so a failure could be summarised,
  // and its cost was the whole log: a step that fails on a runner sends only the last 12 lines to an
  // annotation, and the annotations here say "exit code 2" and nothing else. A gate whose failure
  // cannot be diagnosed from CI is a gate that gets re-run until it passes by accident.
  const install = step('install', [BUN, 'install', '--no-summary'], directory);
  if (install !== 0) {
    return {
      failures: [{ framework, phase: 'install', detail: 'see the `$ bun install` output above' }],
    };
  }

  // `bun run <script>` rather than `bun x`, so the template's own pinned binary is what runs. The
  // package is invoked for the same reason `npm run` would: it puts the step's output *last* in the
  // log, and the last lines are the only ones a failure annotation can carry.
  const [typecheckBinary = 'tsc', ...typecheckArgs] = typecheck.split(' ');
  if (step('typecheck', [BUN, 'run', typecheckBinary, ...typecheckArgs], directory) !== 0) {
    failures.push({
      framework,
      phase: 'typecheck',
      detail: `typecheck failed — see the output above`,
    });
  }

  if (step('build', [BUN, 'run', 'build'], directory) !== 0) {
    failures.push({
      framework,
      phase: 'build',
      detail: '`vite build` failed — see the output above',
    });
  }

  const output = join(directory, BUILD_DIR);
  if (!failures.some((failure) => failure.phase === 'build') && !existsSync(output)) {
    failures.push({
      framework,
      phase: 'build',
      detail: `vite build reported success but wrote no ${BUILD_DIR}/`,
    });
  }

  if (failures.length > 0) return { failures };

  const built = run(['du', '-sk', output], directory);
  const kibibytes = Number(built.output.split(/\s+/u)[0] ?? '0');
  const files = run(['sh', '-c', `find ${BUILD_DIR} -type f | wc -l`], directory);
  return {
    failures,
    result: {
      framework,
      bytes: Math.round(kibibytes * 1024),
      files: Number(files.output.trim()),
    },
  };
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  const integrations = configuredTemplates(readFileSync(CONFIG, 'utf8'));
  if (integrations.length === 0) {
    process.stdout.write('  · the configuration ships no frontend templates; nothing to verify\n');
    return;
  }

  const work = await mkdtemp(join(tmpdir(), 'tsir-templates-'));
  const emitted = await emitFrontendTemplates(work, integrations);

  const failures: TemplateFailure[] = [];
  const rows: string[] = [];
  for (const template of emitted) {
    const directory = join(work, 'templates', template.framework);
    const { failures: templateFailures, result } = await verifyTemplate(
      directory,
      template.framework,
    );
    failures.push(...templateFailures);
    if (result !== undefined) {
      rows.push(
        `  ✓ ${result.framework.padEnd(8)} install · typecheck (${
          typecheckScript(result.framework).split(' ')[0]
        }) · build  ${kilobytes(result.bytes).padStart(9)}  ${String(result.files).padStart(
          3,
        )} file(s)`,
      );
    } else {
      rows.push(`  ✗ ${template.framework.padEnd(8)} failed`);
    }
  }

  if (!keep) await rm(work, { recursive: true, force: true });

  process.stdout.write('\n  frontend templates\n\n');
  process.stdout.write(`${rows.join('\n')}\n`);
  if (keep) process.stdout.write(`\n  work directory kept: ${work}\n`);

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`\n  ✗ ${failure.framework} · ${failure.phase}\n`);
      for (const line of failure.detail.split('\n')) process.stderr.write(`    ${line}\n`);
    }
    process.stderr.write('\n');
    process.exit(1);
  }
  process.stdout.write('\n  ✓ every configured template installs, typechecks and builds\n\n');
}

if (import.meta.main) await main();
