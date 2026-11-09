/**
 * `tsir doctor` — diagnose a project.
 *
 * Read-only, and it never prints a secret value: configuration is reported
 * through the masked view only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { probeCapabilities } from '@tsir/core';

import { boolFlag, parseArgs } from '../args.ts';
import { loadProject } from '../project.ts';
import { loadProjectCommands, unknownConsoleCommands } from './project-command.ts';
import { repairDeployRegion } from './bootstrap.ts';
import { info, jsonDocument, style, CliError, symbols } from '../output.ts';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly hint?: string;
}

const MINIMUM_BUN = [1, 2] as const;

function checkRuntime(): Check {
  const parts = Bun.version.split('.');
  const major = Number.parseInt(parts[0] ?? '0', 10); // coercion-ok: Bun.version is framework-controlled
  const minor = Number.parseInt(parts[1] ?? '0', 10); // coercion-ok: Bun.version is framework-controlled
  const tooOld = major < MINIMUM_BUN[0] || (major === MINIMUM_BUN[0] && minor < MINIMUM_BUN[1]);
  return {
    name: 'runtime',
    status: tooOld ? 'fail' : 'ok',
    detail: `bun ${Bun.version} · requires >= ${MINIMUM_BUN.join('.')}`,
    ...(tooOld ? { hint: 'upgrade Bun before running Tsir' } : {}),
  };
}

/**
 * CLI-005 · dependencies: every `@tsir/*` package the project declares must resolve from the
 * project root, and they should all be the same version.
 */
export function checkDependencies(root: string): Check[] {
  const manifestPath = join(root, 'package.json');
  if (!existsSync(manifestPath)) {
    return [
      { name: 'dependencies', status: 'warn', detail: 'no package.json at the project root' },
    ];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith('@tsir/'))
    .sort();
  const missing: string[] = [];
  const versions = new Map<string, string>();
  for (const name of declared) {
    try {
      const resolved = Bun.resolveSync(`${name}/package.json`, root);
      const version = (JSON.parse(readFileSync(resolved, 'utf8')) as { version?: string }).version;
      versions.set(name, version ?? 'unknown');
    } catch {
      missing.push(name);
    }
  }
  const checks: Check[] = [];
  if (missing.length > 0) {
    checks.push({
      name: 'dependencies',
      status: 'fail',
      detail: `not installed: ${missing.join(', ')}`,
      hint: 'run `bun install` in the project root',
    });
  } else {
    checks.push({
      name: 'dependencies',
      status: 'ok',
      detail: `${String(declared.length)} @tsir packages resolve`,
    });
  }
  const distinct = [...new Set(versions.values())];
  if (distinct.length > 1) {
    const listing = [...versions].map(([name, version]) => `${name}@${version}`).join(', ');
    checks.push({
      name: 'versions',
      status: 'warn',
      detail: `mixed @tsir versions: ${listing}`,
      hint: 'align them so one framework version runs everywhere',
    });
  } else if (distinct.length === 1) {
    checks.push({ name: 'versions', status: 'ok', detail: `@tsir ${distinct[0] ?? 'unknown'}` });
  }
  return checks;
}

/**
 * CLI-005 · ports: if the configuration names a port, check that it is free. Only the number is
 * read; this never reports anything else from the configuration.
 */
export async function checkPort(
  masked: Readonly<Record<string, unknown>>,
): Promise<Check | undefined> {
  const key = ['PORT', 'HTTP_PORT'].find((candidate) => masked[candidate] !== undefined);
  if (key === undefined) return undefined;
  const port = Number.parseInt(String(masked[key]), 10); // coercion-ok: a configured port, validated below
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      name: 'port',
      status: 'fail',
      detail: `${key} is not a valid port`,
      hint: `set ${key} to 1–65535`,
    };
  }
  try {
    const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    probe.stop(true);
    return { name: 'port', status: 'ok', detail: `${key}=${String(port)} is free` };
  } catch {
    return {
      name: 'port',
      status: 'warn',
      detail: `${key}=${String(port)} is in use`,
      hint: 'stop the process holding it, or choose another port',
    };
  }
}

/** The `--fix` line of the report (`CFG-119`): what the repair did, or why it did not. */
async function fixCheck(): Promise<Check> {
  try {
    const result = await repairDeployRegion(process.cwd());
    switch (result.kind) {
      case 'no-record':
        return { name: 'fix', status: 'ok', detail: 'nothing to fix: no .tsir/bootstrap.json' };
      case 'unchanged':
        return { name: 'fix', status: 'ok', detail: 'managed:deploy already matches the record' };
      case 'repaired':
        return { name: 'fix', status: 'ok', detail: `updated ${result.config} (managed:deploy)` };
      case 'refused':
        return { name: 'fix', status: 'warn', detail: result.reason, hint: result.hint };
    }
  } catch (error: unknown) {
    return {
      name: 'fix',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function doctorCommand(
  argv: readonly string[],
  knownCommands: readonly string[] = [],
): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable output' },
    '--fix': {
      type: 'boolean',
      description:
        'restore the managed:deploy region from .tsir/bootstrap.json (never unmanaged text)',
    },
  });
  const json = boolFlag(args, '--json');
  const checks: Check[] = [checkRuntime()];
  if (boolFlag(args, '--fix')) checks.push(await fixCheck());

  let projectRoot: string | undefined;

  try {
    const project = await loadProject(process.cwd());
    projectRoot = project.root;
    checks.push({
      name: 'tsir.js',
      status: 'ok',
      detail: `${project.configPath.slice(project.root.length + 1)} → app "${project.config.app.name}"`,
    });
    checks.push({ name: 'entry', status: 'ok', detail: project.config.app.entry });
    checks.push(...checkDependencies(project.root));
    const listed = project.config.console?.commands ?? [];
    if (listed.length > 0) {
      // CLI-020: a project command the entry exports is a valid name too (CLI-019).
      let ownNames: string[] = [];
      try {
        ownNames = (await loadProjectCommands(project.entryPath)).map((command) => command.name);
      } catch (error: unknown) {
        checks.push({
          name: 'commands',
          status: 'fail',
          detail: `the entry's commands export: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const unknown = unknownConsoleCommands(listed, [...knownCommands, ...ownNames]);
      checks.push(
        unknown.length === 0
          ? { name: 'console.commands', status: 'ok', detail: `${String(listed.length)} listed` }
          : {
              name: 'console.commands',
              status: 'fail',
              detail: `unknown: ${unknown.join(', ')} (edit console.commands in tsir.js)`,
            },
      );
    }

    try {
      const config = project.app.load({ mode: 'development' });
      const secrets = Object.entries(config.masked).filter(
        ([, value]) => value === '[redacted]',
      ).length;
      checks.push({
        name: 'config',
        status: 'ok',
        detail: `${String(Object.keys(config.masked).length)} keys valid (${String(secrets)} redacted)`,
      });
      const port = await checkPort(config.masked);
      if (port !== undefined) checks.push(port);
      for (const warning of config.warnings) {
        checks.push({ name: 'config warning', status: 'warn', detail: warning });
      }
    } catch (error: unknown) {
      checks.push({
        name: 'config',
        status: 'fail',
        detail: error instanceof Error ? (error.message.split('\n')[0] ?? 'invalid') : 'invalid',
        hint: 'run `tsir config:dump` after fixing the environment',
      });
    }

    const manifestPath = join(project.root, '.tsir', 'manifest.json');
    if (existsSync(manifestPath)) {
      const expected = project.app.manifest();
      const actual = (await Bun.file(manifestPath).json()) as { sourceHash?: string };
      const stale = actual.sourceHash !== expected.sourceHash;
      checks.push({
        name: 'manifest',
        status: stale ? 'warn' : 'ok',
        detail: stale ? 'stale — run `tsir build`' : `current (${expected.sourceHash})`,
        ...(stale ? { hint: 'production boot refuses a stale manifest (APP_MANIFEST_STALE)' } : {}),
      });
    } else {
      checks.push({
        name: 'manifest',
        status: 'warn',
        detail: 'not generated yet',
        hint: 'run `tsir build` before a production boot',
      });
    }
  } catch (error: unknown) {
    checks.push({
      name: 'project',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      hint:
        error instanceof CliError && error.hint !== undefined
          ? error.hint
          : 'run `tsir bootstrap` inside an existing application, or scaffold one with `tsir new`',
    });
  }

  const capabilities = probeCapabilities();
  checks.push({
    name: 'runtime target',
    status: 'ok',
    detail: `${capabilities.target} · ${capabilities.list.join(', ')}`,
  });

  if (json) {
    info(
      jsonDocument({
        ok: checks.every((check) => check.status !== 'fail'),
        projectRoot,
        checks,
      }),
    );
    return checks.some((check) => check.status === 'fail') ? 1 : 0;
  }

  info('');
  info(`  ${style.bold('tsir doctor')}`);
  info('');
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    const symbol =
      check.status === 'ok'
        ? style.green(symbols.check)
        : check.status === 'warn'
          ? style.yellow(symbols.warn)
          : style.red(symbols.cross);
    info(`  ${symbol} ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.hint !== undefined) info(`    ${style.dim(`↳ ${check.hint}`)}`);
  }

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  info('');
  const plural = (count: number, word: string): string =>
    `${String(count)} ${word}${count === 1 ? '' : 's'}`;
  info(
    `  ${String(checks.length - failures - warnings)} ok · ${plural(warnings, 'warning')} · ${plural(failures, 'failure')}`,
  );
  info('');

  return failures > 0 ? 1 : 0;
}
