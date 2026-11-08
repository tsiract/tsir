/**
 * The visual vocabulary: colours, glyphs and spacing.
 *
 * One place decides what a Tsir screen looks like. Commands choose *what* to show; this module
 * decides how it reads, so two commands written months apart still look like one product.
 *
 * Colour is opt-out. Every value here degrades to plain text when the terminal cannot do colour
 * (`NO_COLOR`, `TERM=dumb`, or a non-TTY), because colour that cannot be disabled is colour that
 * breaks somebody's pipe.
 */

/** True when the environment asks for plain output. `NO_COLOR` is a de-facto standard (no-color.org). */
export function colorDisabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return true;
  return env['TERM'] === 'dumb';
}

/** ANSI SGR codes, by role. Roles, not colours: a theme change must not touch a call site. */
export const STYLE = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  italic: '\u001B[3m',
  underline: '\u001B[4m',
  brand: '\u001B[36m',
  accent: '\u001B[35m',
  success: '\u001B[32m',
  warning: '\u001B[33m',
  danger: '\u001B[31m',
  muted: '\u001B[90m',
} as const;

export type Role = 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'bold' | 'dim';

export interface Palette {
  readonly color: boolean;
  paint(role: Role, text: string): string;
  /** Several roles at once, outermost first. */
  paintAll(roles: readonly Role[], text: string): string;
}

/** A palette that emits SGR codes when allowed and nothing when not. */
export function createPalette(options: { color?: boolean } = {}): Palette {
  const color = options.color ?? !colorDisabled();
  return {
    color,
    paint(role, text) {
      if (!color) return text;
      return `${STYLE[role]}${text}${STYLE.reset}`;
    },
    paintAll(roles, text) {
      if (!color || roles.length === 0) return text;
      const open = roles.map((role) => STYLE[role]).join('');
      return `${open}${text}${STYLE.reset}`;
    },
  };
}

/**
 * Glyphs.
 *
 * `unicode` is the default. `ascii` exists for terminals that cannot encode box drawing or
 * arrows — legacy Windows consoles behind certain terminals, and some CI log viewers that mangle
 * them. Detection is by explicit request or `TSIR_TUI=ascii`, never by guesswork at runtime.
 */
export const GLYPHS = {
  unicode: {
    rule: '─',
    corner: '┌',
    tee: '├',
    vertical: '│',
    arrow: '›',
    check: '✓',
    cross: '✗',
    warn: '!',
    bullet: '·',
    selected: '●',
    unselected: '○',
  },
  ascii: {
    rule: '-',
    corner: '+',
    tee: '+',
    vertical: '|',
    arrow: '>',
    check: 'OK',
    cross: 'x',
    warn: '!',
    bullet: '-',
    selected: '(x)',
    unselected: '( )',
  },
} as const;

export type GlyphSet = {
  readonly [K in keyof (typeof GLYPHS)['unicode']]: string;
};

export function glyphs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GlyphSet {
  if (env['TSIR_TUI'] === 'ascii') return GLYPHS.ascii;
  return GLYPHS.unicode;
}

/** Terminal width, clamped so a layout does not collapse on a very narrow or very wide terminal. */
export function terminalWidth(min = 48, max = 88): number {
  const columns = process.stdout.columns;
  if (typeof columns !== 'number' || columns <= 0) return Math.min(max, 72);
  return Math.max(min, Math.min(max, columns));
}

/** Every screen uses this width, so headings and rules line up across commands. */
export const CONTENT_WIDTH = 72;

/** Left indent for body text and options. Wide enough to read, narrow enough to fit a rule. */
export const INDENT = '  ';

/** A horizontal rule sized to the content width. */
export function rule(palette: Palette, width = CONTENT_WIDTH): string {
  return palette.paint('muted', GLYPHS.unicode.rule.repeat(width));
}
