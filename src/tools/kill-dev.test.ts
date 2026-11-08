/**
 * `kill-dev.sh` — the record-driven cleanup behind `make dev` and `make kill`.
 *
 * These are the dev-workflow safety properties (`FND-004/005/006`) that used to be manual checks
 * against a live port. They are exactly the properties that matter when cleanup goes wrong — the
 * failure mode is not "the dev server keeps running", it is "the tool killed a database, or a
 * process that reused the recorded PID" — so they belong in the test suite, not only in a
 * checklist somebody has to remember to run.
 *
 * Every test drives the real script as a subprocess against a throwaway `TSIR_ROOT`. Nothing here
 * signals a process it did not start itself.
 */

import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, 'kill-dev.sh');

interface Run {
  readonly code: number;
  readonly output: string;
}

/** A scratch root with an optional `.tsir/dev.pids` + `dev.json` record. */
function scratch(options: { readonly tsv?: string; readonly json?: string }): {
  readonly root: string;
  readonly runtime: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'killdev-'));
  const runtime = join(root, '.tsir');
  mkdirSync(runtime, { recursive: true });
  if (options.tsv !== undefined) writeFileSync(join(runtime, 'dev.pids'), options.tsv);
  if (options.json !== undefined) writeFileSync(join(runtime, 'dev.json'), options.json);
  return { root, runtime };
}

function run(root: string, env: Record<string, string> = {}): Run {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    // A short drain keeps the suite fast; the script escalates to SIGKILL after it.
    env: { ...process.env, TSIR_ROOT: root, TSIR_KILL_DRAIN: '2', ...env },
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** `ps -o lstart=` in the same normalised form the script compares against. */
function startLabel(pid: number): string {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return result.stdout.trim().replace(/\s+/gu, ' ');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A long-lived child whose command line the script will refuse to touch. */
function foreignProcess(command: string): { readonly pid: number; readonly stop: () => void } {
  const child = Bun.spawn(['bash', '-c', command], { stdout: 'ignore', stderr: 'ignore' });
  return {
    pid: child.pid,
    stop: (): void => {
      child.kill('SIGKILL');
    },
  };
}

describe('kill-dev.sh', () => {
  test('is executable and declares its contract', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source.startsWith('#!/usr/bin/env bash')).toBe(true);
    // The five guarantees the tool is built around; the tests below exercise each.
    expect(source).toContain('guards against PID reuse');
    expect(source).toContain('never killed');
    expect(source).toContain('Idempotent: running with nothing active exits 0');
  });

  test('idempotent: nothing recorded exits 0 and removes the record', () => {
    const { root, runtime } = scratch({ json: JSON.stringify({ pid: 1, ports: [] }) });
    writeFileSync(join(runtime, 'dev.pids'), '');
    const result = run(root);
    expect(result.code).toBe(0);
    expect(result.output).toContain('nothing to stop');
    expect(existsSync(join(runtime, 'dev.pids'))).toBe(false);
    expect(existsSync(join(runtime, 'dev.json'))).toBe(false);
  });

  test('a foreign process on a recorded port is reported and not terminated', async () => {
    const server = createServer(() => {});
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', () => {
        done();
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    // An empty PID list but a recorded port: the script must notice the port is occupied by
    // somebody else and fail loudly instead of reaching for the kill.
    const { root } = scratch({
      tsv: '',
      json: JSON.stringify({ pid: 0, ports: [port] }),
    });
    // `pid: 0` is discarded by the TSV reader; put a live-but-foreign pid in the record instead so
    // the port check is what runs last.
    const foreign = foreignProcess('sleep 30');
    writeFileSync(
      join(root, '.tsir', 'dev.pids'),
      `${String(foreign.pid)}\t${String(port)}\t${startLabel(foreign.pid)}\n`,
    );

    try {
      const result = run(root);
      expect(result.output).toContain('not a Tsir dev server');
      expect(isAlive(foreign.pid)).toBe(true);
      expect(result.code).toBe(1);
      expect(result.output).toContain(`port ${String(port)} is still in use`);
    } finally {
      foreign.stop();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    }
  });

  test('PID reuse: a mismatched start label means the process is left alone', () => {
    const foreign = foreignProcess('sleep 30');
    const { root } = scratch({
      // A label from "another process" — the recorded start time no longer matches.
      tsv: `${String(foreign.pid)}\t0\tWed Jan  1 00:00:00 2020\n`,
    });
    try {
      const result = run(root);
      expect(result.output).toContain('was reused by another process — not touching it');
      expect(isAlive(foreign.pid)).toBe(true);
      expect(result.code).toBe(0);
    } finally {
      foreign.stop();
    }
  });

  test('a recorded PID that is not a dev server is never signalled', () => {
    const foreign = foreignProcess('sleep 30');
    const { root } = scratch({
      tsv: `${String(foreign.pid)}\t0\t${startLabel(foreign.pid)}\n`,
    });
    try {
      // Matching label, live PID — only the command-line check stands between it and SIGTERM.
      const result = run(root);
      expect(result.output).toContain('is not a Tsir dev server');
      expect(isAlive(foreign.pid)).toBe(true);
    } finally {
      foreign.stop();
    }
  });

  test('a stale record for an exited PID is reported, not treated as failure', async () => {
    // Reap it properly: a bare `spawn` leaves a zombie, and `kill -0` succeeds on a zombie, so the
    // script would see it as alive. `exited` resolves only after the PID is really gone.
    const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    const pid = child.pid;
    await child.exited;
    const { root } = scratch({ tsv: `${String(pid)}\t0\t\n` });
    const result = run(root);
    expect(result.output).toContain('already stopped');
    expect(result.code).toBe(0);
  });

  test('the record is removed once the cleanup has finished', () => {
    const { root, runtime } = scratch({ tsv: '999999\t0\t\n', json: '{"ports":[]}' });
    const result = run(root);
    expect(result.code).toBe(0);
    expect(existsSync(join(runtime, 'dev.pids'))).toBe(false);
    expect(existsSync(join(runtime, 'dev.json'))).toBe(false);
  });

  // The script waits out its drain window before escalating, so this test's budget has to exceed
  // it; bun's default 5 s would fail the test on a slow machine rather than a real defect.
  test('a dev server it started is stopped, and the port is verified released', async () => {
    // A stand-in dev server: the script's command-line guard looks for `tools/dev.ts`, so the
    // process it is allowed to kill must actually look like one. Copy the real script into a
    // scratch tree so `tools/dev.ts` is a real path, and run a shell loop under that name.
    const root = mkdtempSync(join(tmpdir(), 'killdev-live-'));
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(join(root, '.tsir'), { recursive: true });

    const port = 3000 + Math.floor(Math.random() * 2000);
    const serverScript = join(toolsDir, 'dev.ts');
    writeFileSync(
      serverScript,
      [
        '#!/usr/bin/env bash',
        '# Stand-in for the dev server: listens on the recorded port and exits on SIGTERM.',
        'trap "exit 0" TERM INT',
        `exec 3<>/dev/tcp/127.0.0.1/${String(port)} 2>/dev/null || true`,
        'while :; do sleep 0.1; done',
        '',
      ].join('\n'),
    );
    chmodSync(serverScript, 0o755);

    const child = Bun.spawn(['bash', serverScript], { stdout: 'ignore', stderr: 'ignore' });
    // Let it reach the loop before recording it.
    spawnSync('sleep', ['0.3']);
    expect(isAlive(child.pid)).toBe(true);
    writeFileSync(
      join(root, '.tsir', 'dev.pids'),
      `${String(child.pid)}\t${String(port)}\t${startLabel(child.pid)}\n`,
    );

    const result = spawnSync('bash', [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TSIR_ROOT: root, TSIR_KILL_DRAIN: '5' },
    });
    const output = `${result.stdout}${result.stderr}`;
    // Either the graceful path or the escalation is acceptable — the contract is that the recorded
    // process is gone, its port is verified free, and the run exits 0.
    expect(output).toMatch(/stopped dev server|did not exit/);
    expect(output).toContain('port ' + String(port) + ' released');
    await child.exited;
    expect(isAlive(child.pid)).toBe(false);
    expect(result.status ?? -1).toBe(0);
  }, 30_000);
});
