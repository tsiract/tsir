/**
 * In-process CLI runner for the console tests.
 *
 * Spawning `cli.ts` per assertion keeps the tests honest about the process boundary, but Bun's
 * coverage cannot see code that runs in a child process, so the command files read as untested.
 * This runs the same `runCli` entry point in the test process instead: stdout and stderr are
 * captured, the working directory and environment are restored afterwards, and nothing exits.
 *
 * The subprocess form is still exercised by `cli-json.test.ts` and `drivers.test.ts`, which need
 * the real `argv` and exit-code path.
 */

import { runCli } from '../src/index.ts';

export interface CliRun {
  readonly code: number;
  /** Everything written to stdout. */
  readonly stdout: string;
  /** Everything written to stderr. */
  readonly stderr: string;
  /** stdout then stderr, the same shape the subprocess helpers produced. */
  readonly output: string;
}

export interface CliRunOptions {
  readonly cwd: string;
  /** Overrides for `process.env`. `undefined` removes the variable for the duration of the run. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function runCliInProcess(
  args: readonly string[],
  options: CliRunOptions,
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const text = (chunk: unknown): string =>
    typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  // Some commands print with `console.*`, which does not go through the stream writers.
  const consoleMethods = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };

  process.stdout.write = (chunk: unknown): boolean => {
    out.push(text(chunk));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    err.push(text(chunk));
    return true;
  };
  process.chdir(options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  console.log = (...parts: unknown[]) => out.push(`${parts.map(String).join(' ')}\n`);
  console.info = console.log;
  console.warn = (...parts: unknown[]) => err.push(`${parts.map(String).join(' ')}\n`);
  console.error = console.warn;

  try {
    const code = await runCli(args);
    const stdout = out.join('');
    const stderr = err.join('');
    return { code, stdout, stderr, output: `${stdout}${stderr}` };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    Object.assign(console, consoleMethods);
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

/**
 * The original subprocess runner, kept for the groups that depend on a fresh process.
 *
 * Some project loads keep state the process cannot forget: the entry module and the registries
 * it fills are cached for the life of the process, so a second project loaded in the same test
 * run can see the first one's routes and units. Those groups stay on a child process, where each
 * run starts clean. Everything else runs in-process so that its code shows up in coverage.
 */
export function runCliSubprocess(args: readonly string[], cwd: string): CliRun {
  const result = Bun.spawnSync([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return { code: result.exitCode ?? -1, stdout, stderr, output: `${stdout}${stderr}` };
}

const CLI_ENTRY = new URL('../src/cli.ts', import.meta.url).pathname;
