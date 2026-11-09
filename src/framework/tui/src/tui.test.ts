import { describe, expect, test } from 'bun:test';

import { canPrompt, NotInteractiveError, requireInteractive } from './session.ts';
import { createPalette, colorDisabled, glyphs, GLYPHS } from './theme.ts';
import { Reporter, wrap } from './report.ts';
import { normalizeKey, PromptCancelled } from './prompts.ts';
import { banner, frameworkVersion, versionLine } from './branding.ts';

// The interactive layer needs a terminal, so it is exercised against a real pty (see the
// `tui-interactive` check in `make check`). Everything here is the deterministic part: the rules
// that decide *whether* a prompt may run, and the text that a non-interactive run produces.

// `env: {}` everywhere: these tests are about the rule, and the rule reads `process.env` when no
// environment is injected. Under `CI=true` — which is where `make check` runs them, because
// `readme-badges` runs the suite before it will publish a passing-tests badge — the ambient
// environment would refuse every case and the assertions below would test nothing.
const NO_ENV = { env: {} } as const;

describe('interactivity is a capability', () => {
  test('needs both a stdin and a stdout terminal', () => {
    expect(canPrompt({ ...NO_ENV, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(canPrompt({ ...NO_ENV, stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
    expect(canPrompt({ ...NO_ENV, stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
  });

  test('an explicit --no-interactive wins over a real terminal', () => {
    expect(canPrompt({ ...NO_ENV, requested: false, stdinIsTTY: true, stdoutIsTTY: true })).toBe(
      false,
    );
  });

  test('CI is treated as a refusal even with a pseudo-terminal attached', () => {
    // A CI log is not something anyone can arrow through, and a wizard that waits there is a hang.
    expect(canPrompt({ env: { CI: 'true' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(
      canPrompt({ env: { TSIR_NO_INTERACTIVE: '1' }, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe(false);
  });

  test('an explicit --interactive still requires a terminal rather than pretending', () => {
    expect(canPrompt({ ...NO_ENV, requested: true, stdinIsTTY: false })).toBe(false);
    expect(canPrompt({ ...NO_ENV, requested: true, stdinIsTTY: true })).toBe(true);
  });

  test('requireInteractive names the command and the way out', () => {
    expect(() =>
      requireInteractive('the wizard', 'pass --frontend svelte', { ...NO_ENV, stdinIsTTY: false }),
    ).toThrow(NotInteractiveError);
    try {
      requireInteractive('the wizard', 'pass --frontend svelte', { ...NO_ENV, stdinIsTTY: false });
    } catch (error) {
      expect((error as NotInteractiveError).code).toBe('TUI_NO_TERMINAL');
      expect((error as NotInteractiveError).hint).toBe('pass --frontend svelte');
    }
  });
});

describe('the banner is a box, not a guess', () => {
  /** Every line of the banner, with SGR escapes removed, so lengths are cell counts. */
  const plain = (
    options: { readonly color?: boolean; readonly version?: string; readonly width?: number } = {},
  ): string[] =>
    banner({
      palette: createPalette({ color: options.color ?? false }),
      title: 'tsir',
      subtitle: 'Development environment',
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.width === undefined ? {} : { width: options.width }),
    })
      .replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu'), '')
      .split('\n');

  test('the title line and the rule are the same width, with and without colour', () => {
    // The bug this pins: the gap was computed from the *painted* title, so a coloured banner lost
    // the length of the escape codes and the frame stepped in by that many columns.
    for (const color of [false, true]) {
      for (const version of [undefined, '0.1.2', '10.20.30']) {
        const lines = plain({ color, ...(version === undefined ? {} : { version }) });
        const title = lines[0] ?? '';
        const rule = lines[lines.length - 1] ?? '';
        expect(title.length).toBe(rule.length);
      }
    }
  });

  test('the box honours an explicit width, borders included', () => {
    const lines = plain({ width: 50, version: '1.0.0' });
    expect((lines[0] ?? '').length).toBe(50);
    expect((lines[lines.length - 1] ?? '').length).toBe(50);
  });

  test('the version is right-aligned against the frame, and absent when unknown', () => {
    const withVersion = plain({ version: '9.9.9' })[0] ?? '';
    expect(withVersion.endsWith('v9.9.9│')).toBe(true);
    const withoutVersion = plain()[0] ?? '';
    expect(withoutVersion.includes('v')).toBe(false);
  });
});

describe('colour and glyphs are opt-out', () => {
  test('NO_COLOR and TERM=dumb disable colour', () => {
    expect(colorDisabled({ NO_COLOR: '1' })).toBe(true);
    expect(colorDisabled({ TERM: 'dumb' })).toBe(true);
    expect(colorDisabled({})).toBe(false);
    const plain = createPalette({ color: false });
    expect(plain.paint('danger', 'x')).toBe('x');
    expect(plain.paintAll(['bold', 'brand'], 'x')).toBe('x');
  });

  test('an ASCII glyph set exists for terminals that cannot encode box drawing', () => {
    const set = glyphs({ TSIR_TUI: 'ascii' });
    expect(set).toEqual(GLYPHS.ascii);
    expect(glyphs({}).rule).toBe('─');
    for (const value of Object.values(set)) expect(value.length).toBeLessThanOrEqual(3);
  });
});

describe('reporter', () => {
  const palette = createPalette({ color: false });

  test('a check prints a marker, an aligned label and an optional detail', () => {
    const reporter = new Reporter(palette);
    reporter.check({ status: 'ok', label: 'deps', detail: '10 resolve' });
    reporter.check({ status: 'fail', label: 'manifest', detail: 'missing' });
    expect(reporter.toString()).toContain('✓');
    expect(reporter.toString()).toContain('deps');
    expect(reporter.toString()).toContain('10 resolve');
    expect(reporter.toString()).toContain('✗');
    expect(reporter.toString()).toContain('manifest');
  });

  test('a summary counts each status and lists the next steps', () => {
    const reporter = new Reporter(palette);
    reporter.summary({ ok: 3, warnings: 1, failures: 0, next: ['run tsir build'] });
    const text = reporter.toString();
    expect(text).toContain('3 ok');
    expect(text).toContain('1 warning(s)');
    expect(text).toContain('run tsir build');
  });

  test('a table aligns right-hand numeric columns', () => {
    const reporter = new Reporter(palette);
    reporter.table(
      [{ header: 'template' }, { header: 'packages', align: 'right' }],
      [
        ['backend', '10'],
        ['svelte', '1'],
      ],
    );
    const lines = reporter.toLines();
    expect(lines[0]).toContain('packages');
    expect(lines[1]!.trim()).toMatch(/^-+ +-+$/u);
    // Columns are sized to the widest cell, then right-aligned: `packages` is 8 wide.
    expect(lines[2]!.trimEnd()).toBe('  backend         10');
    expect(lines[3]!.trimEnd()).toBe('  svelte           1');
  });

  test('wrap never drops or splits a word, even one wider than the line', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrap('supercalifragilistic', 4)).toEqual(['supercalifragilistic']);
    expect(wrap('', 10)).toEqual(['']);
  });
});

describe('key normalisation', () => {
  test('ctrl+c is distinguishable from a literal c', () => {
    // In raw mode Ctrl+C never becomes SIGINT — the byte arrives as a keypress with a modifier. A
    // prompt that only compared `name === 'c'` would either cancel on every "c" or never cancel.
    const ctrlC = normalizeKey({ name: 'c', sequence: '\u0003', ctrl: true });
    expect(ctrlC).toEqual({ name: 'c', ctrl: true, sequence: '\u0003' });
    expect(normalizeKey({ name: 'c', sequence: 'c' }).ctrl).toBe(false);
    expect(normalizeKey({ sequence: '\u001b[B' }).name).toBe('\u001b[B');
  });

  test('PromptCancelled carries a stable code for callers that branch on it', () => {
    expect(new PromptCancelled().code).toBe('TUI_CANCELLED');
  });
});

describe('identity', () => {
  test('the version comes from the package manifest, not a constant', () => {
    const version = frameworkVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(versionLine({ bun: '1.4.4' })).toBe(`tsir ${version} · bun 1.4.4`);
  });
});
