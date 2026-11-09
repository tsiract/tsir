/**
 * `make doctor` — diagnose the local Tsir environment.
 *
 * Read-only. Never mutates state, never prints secret values.
 * Later phases extend this into `tsir doctor` (CLI-005).
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The shared terminal layer, not a private set of escape codes: `make doctor` must print the same
// glyphs, the same alignment and the same summary as every other Tsir command (ADR-0031). The root
// entrypoint is the reporting path, so this imports no renderer and works in a pipe.
import { INDENT, Reporter } from '../framework/tui/src/index.ts';

/** `src/tools/doctor.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly hint?: string;
}

const MIN_BUN: readonly [number, number] = [1, 2];

function checkBun(): Check {
  const parts = Bun.version.split('.').map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const required = MIN_BUN[0];
  const requiredMinor = MIN_BUN[1];
  const tooOld = major < required || (major === required && minor < requiredMinor);
  return {
    name: 'bun version',
    status: tooOld ? 'fail' : 'ok',
    detail: `${Bun.version} (requires >= ${String(required)}.${String(requiredMinor)})`,
    ...(tooOld ? { hint: 'upgrade Bun: https://bun.sh/docs/installation' } : {}),
  };
}

function checkDependencies(): Check {
  const installed = existsSync(join(ROOT, 'node_modules'));
  return {
    name: 'dependencies',
    status: installed ? 'ok' : 'warn',
    detail: installed ? 'node_modules present' : 'node_modules missing',
    ...(installed ? {} : { hint: 'run `make install`' }),
  };
}

function checkToolingConfig(): Check {
  const required = [
    'tsconfig.base.json',
    'tsconfig.json',
    'bunfig.toml',
    'Makefile',
    'package.json',
  ];
  const missing = required.filter((file) => !existsSync(join(ROOT, file)));
  return {
    name: 'workspace config',
    status: missing.length === 0 ? 'ok' : 'fail',
    detail:
      missing.length === 0
        ? `${String(required.length)} required files present`
        : `missing: ${missing.join(', ')}`,
  };
}

function checkSpecs(): Check {
  const specs = [
    'status.json',
    join('src', 'docs', 'api-surface.json'),
    join('src', 'docs', 'migrations.md'),
  ];
  const missing = specs.filter((file) => !existsSync(join(ROOT, file)));
  return {
    name: 'spec files',
    status: missing.length === 0 ? 'ok' : 'warn',
    detail: missing.length === 0 ? 'status + docs present' : `missing: ${missing.join(', ')}`,
  };
}

async function checkProjectConfig(): Promise<Check> {
  const candidates = ['tsir.config.js', 'tsir.js', 'tsir.mjs'];
  const found = candidates.filter((file) => existsSync(join(ROOT, file)));
  if (found.length > 1) {
    return {
      name: 'tsir.js',
      status: 'fail',
      detail: `ambiguous: ${found.join(', ')}`,
      hint: 'keep exactly one project configuration file',
    };
  }
  if (found.length === 0) {
    return {
      name: 'tsir.js',
      status: 'warn',
      detail: 'no project configuration (expected for the framework repository itself)',
      hint: 'applications run `tsir bootstrap` (Phase 1)',
    };
  }
  return { name: 'tsir.js', status: 'ok', detail: `${found[0] ?? ''} found` };
}

async function checkDevRecord(): Promise<Check> {
  const record = join(ROOT, '.tsir', 'dev.json');
  if (!existsSync(record)) {
    return { name: 'dev server', status: 'ok', detail: 'not running' };
  }
  try {
    const raw: unknown = await Bun.file(record).json();
    const pid =
      typeof raw === 'object' && raw !== null && 'pid' in raw && typeof raw['pid'] === 'number'
        ? raw['pid']
        : null;
    if (pid === null) {
      return {
        name: 'dev server',
        status: 'warn',
        detail: 'record exists but is unreadable',
        hint: 'run `make kill`',
      };
    }
    const alive = (() => {
      try {
        return process.kill(pid, 0) || true;
      } catch {
        return false;
      }
    })();
    return {
      name: 'dev server',
      status: alive ? 'ok' : 'warn',
      detail: alive
        ? `running (pid ${String(pid)})`
        : `stale record (pid ${String(pid)} not alive)`,
      ...(alive ? {} : { hint: 'run `make kill` to clear the record' }),
    };
  } catch {
    return {
      name: 'dev server',
      status: 'warn',
      detail: 'record exists but cannot be parsed',
      hint: 'run `make kill`',
    };
  }
}

async function checkPort(): Promise<Check> {
  const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
  const open = await (async (): Promise<boolean> => {
    try {
      const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: { data() {}, open() {}, error() {} },
      });
      socket.end();
      return true;
    } catch {
      return false;
    }
  })();
  return {
    name: `port ${String(port)}`,
    status: open ? 'warn' : 'ok',
    detail: open ? 'already in use' : 'available',
    ...(open ? { hint: '`make dev` runs cleanup first; foreign owners are never killed' } : {}),
  };
}

async function main(): Promise<void> {
  const checks: readonly Check[] = [
    checkBun(),
    checkDependencies(),
    checkToolingConfig(),
    checkSpecs(),
    await checkProjectConfig(),
    await checkDevRecord(),
    await checkPort(),
  ];

  const reporter = new Reporter();
  reporter.line('');
  reporter.section('Doctor', { note: 'the local environment, checked and never changed' });
  for (const check of checks) {
    reporter.check({ status: check.status, label: check.name, detail: check.detail });
    if (check.hint !== undefined) {
      reporter.line(`${INDENT}  ${reporter.palette.paint('dim', `↳ ${check.hint}`)}`);
    }
  }

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  reporter.summary({
    ok: checks.length - failures - warnings,
    warnings,
    failures,
    // A failing check is what a person has to act on; the hint under it already says how, so the
    // "what next" line only appears when nothing failed.
    ...(failures === 0 ? { next: ['make dev'] } : {}),
  });
  reporter.flush();
  process.exit(failures > 0 ? 1 : 0);
}

await main();
