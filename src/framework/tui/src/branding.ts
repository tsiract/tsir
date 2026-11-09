/**
 * Product identity.
 *
 * A version string and a banner, in one place, because every screen shows them and they must never
 * disagree with the package that is actually running.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { wrap } from './report.ts';
import { type Palette, CONTENT_WIDTH, INDENT, glyphs } from './theme.ts';

/**
 * The installed framework version.
 *
 * Read from the nearest `package.json` rather than a constant: `make version` keeps the manifests in
 * lockstep, and a constant here would be one more place a release could forget. Two depths are
 * tried because this package is emitted in two layouts — the repository keeps it at
 * `src/framework/tui/src/`, and `make dist` writes `framework/tui/`.
 */
export function frameworkVersion(from: string = import.meta.url): string {
  for (const relative of ['../package.json', './package.json']) {
    try {
      const url = new URL(relative, from);
      const path = fileURLToPath(url);
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
      if (typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Try the next layout.
    }
  }
  return 'unknown';
}

export interface BannerOptions {
  readonly palette: Palette;
  readonly title: string;
  readonly subtitle: string;
  /** Printed at the right of the title line. Omitted when undefined. */
  readonly version?: string;
  /**
   * Extra lines under the subtitle. Wrapped to the content width, because a note longer than the
   * frame is what actually looks broken — a version string that is one column off does not.
   */
  readonly notes?: readonly string[];
  readonly width?: number;
}

/**
 * The header every interactive screen carries.
 *
 * Deliberately textual rather than a box: a full box costs two lines on every screen, and the
 * renderer draws its own frame. What a developer needs at a glance is which product, which
 * environment, and which version.
 */
export function banner(options: BannerOptions): string {
  const { palette } = options;
  // `width` is the box width in **cells**, borders included, and the rule below spans the same
  // cells. Everything before this comment measured the painted string, which made the gap shrink by
  // the length of the SGR escapes — the box only misaligned when colour was on.
  const width = options.width ?? CONTENT_WIDTH;
  const glyph = glyphs();
  const title = palette.paintAll(['bold', 'brand'], ` ${options.title.toUpperCase()} `);
  const versionText = options.version === undefined ? undefined : `v${options.version}`;
  const version = versionText === undefined ? '' : palette.paint('muted', versionText);
  const titleCells = options.title.length + 2;
  const versionCells = versionText === undefined ? 0 : versionText.length + 1;
  const gap = Math.max(1, width - 1 - titleCells - versionCells);
  const lines = [
    `${glyph.vertical}${title}${' '.repeat(gap)}${version}${versionText === undefined ? '' : glyph.vertical}`,
    `${glyph.vertical}${INDENT}${palette.paint('dim', options.subtitle)}`,
    ...(options.notes ?? []).flatMap((note) =>
      wrap(note, width - 1 - INDENT.length).map((line) => `${glyph.vertical}${INDENT}${line}`),
    ),
    `${glyph.tee}${palette.paint('muted', glyph.rule.repeat(width - 1))}`,
  ];
  return lines.join('\n');
}

/** The one-line identity string, used by `--version` and by error reports. */
export function versionLine(runtime: { bun?: string; node?: string } = runtimeVersions()): string {
  const parts = [`tsir ${frameworkVersion()}`, ...(runtime.bun ? [`bun ${runtime.bun}`] : [])];
  return parts.join(' · ');
}

function runtimeVersions(): { bun?: string; node?: string } {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node;
  return {
    ...(bun === undefined ? {} : { bun }),
    ...(node === undefined ? {} : { node }),
  };
}
