/**
 * The non-interactive half: headings, checks, tables, summaries.
 *
 * This module has no renderer dependency, and that is a requirement rather than an accident. Three
 * callers rely on it:
 *
 *   - a command run without a terminal (a pipe, CI, `--no-interactive`),
 *   - `--json`, which must produce the same facts without escape codes,
 *   - tests, which cannot assert against a drawn screen cheaply.
 *
 * Interactive screens are built for a person reading a terminal. These are built so the *same*
 * information survives `| grep`, and so a command's output can be reviewed in a log.
 */

import { type Palette, createPalette, glyphs, INDENT } from './theme.ts';

export interface SectionOptions {
  readonly palette?: Palette;
  /** Printed under the heading in dim text. */
  readonly note?: string;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  readonly status: CheckStatus;
  readonly label: string;
  readonly detail?: string;
}

export interface TableColumn {
  readonly header: string;
  /** Right-align numeric columns. */
  readonly align?: 'left' | 'right';
}

/** Writes accumulated lines to stdout. A reporter is reusable across a command's whole output. */
export class Reporter {
  readonly palette: Palette;
  private readonly lines: string[] = [];

  constructor(palette: Palette = createPalette()) {
    this.palette = palette;
  }

  /** A section heading. Consistent shape so a reader can find the start of each part. */
  section(title: string, options: SectionOptions = {}): this {
    this.lines.push('', `${this.palette.paintAll(['bold', 'brand'], title)}`);
    if (options.note !== undefined) this.lines.push(`${this.palette.paint('dim', options.note)}`);
    this.lines.push('');
    return this;
  }

  blank(): this {
    this.lines.push('');
    return this;
  }

  /** A bare line, optionally styled by role. */
  line(content: string): this {
    this.lines.push(content);
    return this;
  }

  /** A one-line check, aligned: `✓ dependencies   10 @tsir packages resolve`. */
  check(check: Check): this {
    const glyph = glyphs();
    const mark =
      check.status === 'ok'
        ? this.palette.paint('success', glyph.check)
        : check.status === 'warn'
          ? this.palette.paint('warning', glyph.warn)
          : check.status === 'fail'
            ? this.palette.paint('danger', glyph.cross)
            : this.palette.paint('muted', '-');
    const label = check.label.padEnd(18);
    const styled =
      check.status === 'fail'
        ? this.palette.paint('danger', label)
        : check.status === 'warn'
          ? this.palette.paint('warning', label)
          : check.status === 'skip'
            ? this.palette.paint('muted', label)
            : label;
    const detail = check.detail === undefined ? '' : this.palette.paint('dim', check.detail);
    this.lines.push(`${INDENT}${mark} ${styled}${detail}`);
    return this;
  }

  /** A key/value pair, for summaries where the label is not a check. */
  field(label: string, value: string): this {
    this.lines.push(
      `${INDENT}${this.palette.paint('muted', label.padEnd(18))}${value}`,
    );
    return this;
  }

  /** A wrapped paragraph at the shared indent. */
  paragraph(content: string): this {
    for (const line of wrap(content, 68)) this.lines.push(`${INDENT}${line}`);
    return this;
  }

  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): this {
    const widths = columns.map((column, index) =>
      Math.max(
        column.header.length,
        ...rows.map((row) => (row[index] ?? '').length),
      ),
    );
    const render = (cells: readonly string[], style: (value: string) => string): string =>
      `${INDENT}${columns
        .map((column, index) => {
          const value = cells[index] ?? '';
          const pad = ' '.repeat(Math.max(0, widths[index]! - value.length));
          return column.align === 'right' ? `${pad}${style(value)}` : `${style(value)}${pad}`;
        })
        .join('  ')
        .trimEnd()}`;
    this.lines.push(render(columns.map((column) => column.header), (value) => this.palette.paint('muted', value)));
    this.lines.push(`${INDENT}${this.palette.paint('muted', widths.map((width) => '-'.repeat(width)).join('  ').trimEnd())}`);
    for (const row of rows) this.lines.push(render(row, (value) => value));
    return this;
  }

  /** How a command finishes: what happened, and what to do next. */
  summary(options: {
    readonly ok: number;
    readonly warnings?: number;
    readonly failures?: number;
    readonly next?: readonly string[];
  }): this {
    const parts = [this.palette.paint('success', `${String(options.ok)} ok`)];
    if ((options.warnings ?? 0) > 0) parts.push(this.palette.paint('warning', `${String(options.warnings)} warning(s)`));
    if ((options.failures ?? 0) > 0) parts.push(this.palette.paint('danger', `${String(options.failures)} failure(s)`));
    this.lines.push('', `${INDENT}${parts.join(this.palette.paint('muted', ' · '))}`);
    if (options.next !== undefined && options.next.length > 0) {
      this.lines.push('');
      for (const step of options.next) this.lines.push(`${INDENT}${this.palette.paint('muted', glyphs().arrow)} ${step}`);
    }
    this.lines.push('');
    return this;
  }

  toString(): string {
    return this.lines.join('\n');
  }

  flush(): void {
    process.stdout.write(this.toString());
    this.lines.length = 0;
  }

  /** Accumulated lines, for tests that assert on content rather than on a terminal. */
  toLines(): readonly string[] {
    return [...this.lines];
  }
}

/** Word wrap that never breaks a word wider than the limit (it lets the long word overflow instead). */
export function wrap(content: string, width: number): string[] {
  const words = content.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}
