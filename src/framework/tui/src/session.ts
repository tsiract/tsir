/**
 * The renderer's lifetime, and the promise that the terminal is usable afterwards.
 *
 * Two failure modes matter more than any layout detail:
 *
 *   1. **A wizard that hangs.** Interactive mode is right when a person is watching; it is a bug
 *      when a script runs the command. So interactive mode is opt-in *by capability*, not by
 *      default-and-hope: it requires a TTY on stdin and stdout, and honours `--no-interactive`,
 *      `TSIR_NO_INTERACTIVE` and `CI`.
 *   2. **A terminal left in raw mode.** A renderer that exits without restoring leaves the shell
 *      echoing nothing and the cursor invisible. Every path out of a session — normal completion,
 *      thrown error, `Ctrl+C`, `SIGTERM`, `SIGHUP` — restores first, then propagates.
 */

import { createCliRenderer, type CliRenderer } from '@opentui/core';

/** Raised when a command needed a terminal and there was none. Never a hang, always a message. */
export class NotInteractiveError extends Error {
  readonly code = 'TUI_NO_TERMINAL';
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'NotInteractiveError';
  }
}

export interface InteractivityOptions {
  /** Explicit request from a flag (`--no-interactive`, `--interactive`). */
  readonly requested?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
}

/**
 * Whether an interactive interface can run here.
 *
 * A pipe, a redirect, a CI job or an editor command runner all fail this test — and in each of them
 * a prompt would wait for a keystroke that never comes. `CI` is treated as a refusal even when a
 * pseudo-terminal is attached, because a CI log is not something anyone can arrow through.
 */
export function canPrompt(options: InteractivityOptions = {}): boolean {
  if (options.requested === false) return false;
  const env = options.env ?? process.env;
  if (env['TSIR_NO_INTERACTIVE'] === '1' || env['TSIR_NO_INTERACTIVE'] === 'true') return false;
  if (env['CI'] === 'true' || env['CI'] === '1') return false;
  if (options.requested === true) {
    // An explicit `--interactive` still needs a terminal to draw into. Ask for one, never pretend.
    return options.stdinIsTTY ?? process.stdin.isTTY === true;
  }
  const stdin = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdout = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  return stdin && stdout;
}

/** Throws `NotInteractiveError` when a prompt was required but cannot run. Callers catch and report. */
export function requireInteractive(
  what: string,
  hint: string,
  options: InteractivityOptions = {},
): void {
  if (canPrompt(options)) return;
  throw new NotInteractiveError(`${what} needs a terminal`, hint);
}

export interface SessionOptions {
  readonly title?: string;
  /** Leave the screen contents on exit (reports) instead of restoring the previous screen. */
  readonly preserveOutput?: boolean;
}

export interface Session {
  readonly renderer: CliRenderer;
  /** Restores the terminal and closes the renderer. Idempotent. */
  close(): void;
  /** Runs `work`, always closing afterwards — including when `work` throws. */
  run<T>(work: (renderer: CliRenderer) => Promise<T>): Promise<T>;
}

/**
 * Opens a renderer and registers every exit path that has to restore the terminal.
 *
 * The signal handlers are installed here rather than in each command: a command author should not
 * have to remember that `SIGTERM` during a wizard needs the same cleanup as a normal return.
 */
export async function openSession(options: SessionOptions = {}): Promise<Session> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // `alternate-screen` restores the user's scrollback after a wizard; a report that the developer
    // may want to scroll or pipe keeps the main screen.
    screenMode: options.preserveOutput === true ? 'main-screen' : 'alternate-screen',
    useMouse: false,
    // `destroy()` on every path is the whole point of this module, so the renderer must not also
    // own the signal handling — the handlers below restore and then re-raise.
    clearOnShutdown: true,
    targetFps: 30,
  });
  let closed = false;
  const restore = (): void => {
    if (closed) return;
    closed = true;
    try {
      renderer.destroy();
    } catch {
      // A renderer that failed to construct, or was already destroyed, must not mask the real
      // error being unwound past it. Restoration is best-effort by definition.
    }
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => {
    const handler = (): void => {
      restore();
      // Re-raise with the default disposition so the process exits with the conventional status
      // instead of looking like a successful run that produced nothing.
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  const detach = (): void => {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  };

  // Named rather than `this.`-dependent: `run` is destructured by callers, and a method that needs
  // its receiver is a trap in exactly the situation this module exists to make safe.
  const close = (): void => {
    detach();
    restore();
  };
  const session: Session = {
    renderer,
    close,
    async run<T>(work: (renderer: CliRenderer) => Promise<T>): Promise<T> {
      try {
        return await work(renderer);
      } finally {
        close();
      }
    },
  };
  return session;
}

/**
 * Runs an interactive block, or reports exactly what is missing.
 *
 * Commands call this instead of `openSession` directly, so that "no terminal" produces one
 * consistent message rather than each prompt inventing its own.
 */
export async function withSession<T>(
  options: SessionOptions &
    InteractivityOptions & { readonly hint?: string; readonly what?: string },
  work: (renderer: CliRenderer) => Promise<T>,
): Promise<T> {
  requireInteractive(
    options.what ?? 'this command',
    options.hint ??
      'pass the equivalent flags, or set TSIR_NO_INTERACTIVE=0 with a terminal attached',
    options,
  );
  const session = await openSession(options);
  return session.run(work);
}
