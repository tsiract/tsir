/**
 * `make tui-check` — drive the interactive prompts through a real pseudo-terminal.
 *
 * A prompt that looks right in a unit test and hangs in a terminal is precisely the failure this
 * layer exists to prevent, and it is invisible to any assertion that does not involve an actual TTY.
 * So this tool allocates one, sends keystrokes, and checks both what the prompt decided and whether
 * the terminal was left usable afterwards.
 *
 * What it proves, in order:
 *
 *   1. `select` renders, and a bare `Enter` takes the default.
 *   2. Arrow-down moves the selection, and `Enter` returns the *moved-to* value — the first version of
 *      this layer matched a key name the renderer never emits, so navigation silently did nothing.
 *   3. `Esc` cancels with `PromptCancelled`.
 *   4. `Ctrl+C` cancels, and the pty stream contains the escape sequences that restore the cursor and
 *      leave the alternate screen. In raw mode Ctrl+C is a keypress, never a signal; a layer that
 *      waited for SIGINT would hang here.
 *   5. `canPrompt()` reports false without a terminal, so no command can block a pipe or a CI job.
 *
 * It is a check rather than a test because it needs a real terminal, and `bun test` may run without
 * one. `make check` runs it; the header says what it would catch.
 *
 * Usage: bun src/tools/check-tui.ts [--verbose]
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const VERBOSE = process.argv.includes('--verbose');

/** The subset of `canPrompt`'s options this check exercises. */
interface InteractivityProbe {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

interface Script {
  readonly name: string;
  readonly keys: readonly Buffer[];
  /** Assertions against the file the child writes. */
  readonly expectLog: (log: string) => string | undefined;
  /** Assertions against the raw pty bytes. */
  readonly expectBytes?: (bytes: Buffer) => string | undefined;
  readonly waitMs?: number;
}

const ENTER = Buffer.from([0x0d]);
const DOWN = Buffer.from('\u001B[B');
const UP = Buffer.from('\u001B[A');
const ESC = Buffer.from([0x1b]);
const CTRL_C = Buffer.from([0x03]);

const SCRIPTS: readonly Script[] = [
  {
    name: 'a bare Enter takes the default',
    keys: [ENTER],
    expectLog: (log) =>
      log.includes('chose svelte') ? undefined : `expected "chose svelte", log: ${log}`,
  },
  {
    name: 'arrow-down moves the selection',
    keys: [DOWN, ENTER],
    expectLog: (log) =>
      log.includes('chose react') ? undefined : `expected "chose react", log: ${log}`,
  },
  {
    name: 'arrow-up wraps to the last option',
    keys: [UP, ENTER],
    expectLog: (log) =>
      log.includes('chose vue') ? undefined : `expected "chose vue", log: ${log}`,
  },
  {
    name: 'Escape cancels with PromptCancelled',
    keys: [ESC],
    expectLog: (log) =>
      log.includes('cancelled PromptCancelled') ? undefined : `expected a cancel, log: ${log}`,
  },
  {
    name: 'Ctrl+C cancels and restores the terminal',
    keys: [CTRL_C],
    expectLog: (log) =>
      log.includes('cancelled PromptCancelled') ? undefined : `expected a cancel, log: ${log}`,
    // The two sequences the renderer emits on the way out: show the cursor again, and leave the
    // alternate screen. Their absence is the bug a user reports as "my shell is broken now".
    expectBytes: (bytes) => {
      if (!bytes.includes(Buffer.from('\u001B[?25h'))) return 'cursor was not restored (\\e[?25h)';
      if (!bytes.includes(Buffer.from('\u001B[?1049l')))
        return 'did not leave the alternate screen (\\e[?1049l)';
      return undefined;
    },
  },
];

const CHILD = `
import { appendFileSync } from 'node:fs';
import { openSession, select, PromptCancelled } from ${JSON.stringify(join(ROOT, 'src', 'framework', 'tui', 'src', 'ui.ts'))};
const LOG = process.env['TSIR_TUI_LOG'];
const note = (line) => appendFileSync(LOG, line + '\\n');
const session = await openSession();
try {
  const choice = await select(session.renderer, {
    message: 'Select frontend framework',
    options: [
      { value: 'svelte', label: 'Svelte' },
      { value: 'react', label: 'React' },
      { value: 'vue', label: 'Vue' },
    ],
    defaultValue: 'svelte',
  });
  note('chose ' + choice);
} catch (error) {
  note('cancelled ' + (error instanceof PromptCancelled ? 'PromptCancelled' : String(error)));
}
session.close();
note('closed');
`;

interface Outcome {
  readonly bytes: Buffer;
  readonly log: string;
  readonly code: number | null;
}

/** Runs the child under a pty, feeds it keys, and returns everything it produced. */
async function drive(keys: readonly Buffer[], logPath: string): Promise<Outcome> {
  // A pty needs a native allocation, which Bun exposes through `script(1)`-style helpers only on some
  // platforms; Python's `pty` module is present wherever this repository's CI runs, and using it here
  // keeps the check itself dependency-free in TypeScript.
  const driver = `
import os, pty, select, subprocess, sys, time
keys = [${keys.map((key) => JSON.stringify([...key])).join(', ')}]
master, slave = pty.openpty()
child = subprocess.Popen(
    [${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(CHILD)}],
    stdin=slave, stdout=slave, stderr=slave, env=dict(os.environ, TSIR_TUI_LOG=${JSON.stringify(logPath)}),
)
os.close(slave)
buffer = b''
deadline = time.time() + 2.0
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        try: buffer += os.read(master, 262144)
        except OSError: break
for key in keys:
    os.write(master, bytes(key))
    until = time.time() + 0.5
    while time.time() < until:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try: buffer += os.read(master, 262144)
            except OSError: break
until = time.time() + 2.0
while time.time() < until:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        try: buffer += os.read(master, 262144)
        except OSError: break
try:
    code = child.wait(timeout=6)
except subprocess.TimeoutExpired:
    child.kill(); code = None
sys.stdout.buffer.write(buffer)
sys.exit(0 if code == 0 else 1)
`;
  const python = Bun.spawnSync(['python3', '-c', driver], { stdout: 'pipe', stderr: 'pipe' });
  if (python.exitCode !== 0 && VERBOSE) {
    process.stderr.write(python.stderr.toString());
  }
  const log = await Bun.file(logPath)
    .text()
    .catch(() => '');
  return { bytes: Buffer.from(python.stdout), log, code: python.exitCode };
}

async function main(): Promise<number> {
  // `canPrompt()` must refuse without a terminal, or a command can block a pipe forever.
  const tui = (await import(join(ROOT, 'src', 'framework', 'tui', 'src', 'ui.ts'))) as {
    canPrompt: (options: InteractivityProbe) => boolean;
  };
  const { canPrompt } = tui;
  const failures: string[] = [];
  if (canPrompt({ stdinIsTTY: false, stdoutIsTTY: false }) !== false) {
    failures.push('canPrompt() claimed a terminal is available when none is');
  }

  const dir = mkdtempSync(join(tmpdir(), 'tsir-tui-check-'));
  const script = join(dir, 'select.ts');
  writeFileSync(script, CHILD);
  try {
    for (const spec of SCRIPTS) {
      const logPath = join(dir, 'log.txt');
      writeFileSync(logPath, '');
      const outcome = await drive(spec.keys, logPath);
      const problem = spec.expectLog(outcome.log);
      if (problem !== undefined) {
        failures.push(`${spec.name}: ${problem}`);
        continue;
      }
      if (spec.expectBytes !== undefined) {
        const bytesProblem = spec.expectBytes(outcome.bytes);
        if (bytesProblem !== undefined) {
          failures.push(`${spec.name}: ${bytesProblem}`);
          continue;
        }
      }
      if (outcome.code === null) {
        failures.push(`${spec.name}: the prompt never exited`);
        continue;
      }
      if (VERBOSE) process.stdout.write(`  ok  ${spec.name}\n`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write('\n  interactive prompts are not behaving:\n\n');
    for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`);
    process.stderr.write('\n');
    return 1;
  }
  process.stdout.write(
    `✓ terminal interface: ${String(SCRIPTS.length)} prompt scenario(s) + non-TTY refusal\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
