/**
 * Product identity.
 *
 * A version string and a banner, in one place, because every screen shows them and they must never
 * disagree with the package that is actually running.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  /** Extra lines under the subtitle, already formatted. */
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
  const width = options.width ?? CONTENT_WIDTH;
  const glyph = glyphs();
  const title = palette.paintAll(['bold', 'brand'], ` ${options.title.toUpperCase()} `);
  const version = options.version === undefined ? '' : palette.paint('muted', `v${options.version}`);
  const gap = Math.max(1, width - options.title.length - 2 - (options.version === undefined ? 0 : version.length));
  const lines = [
    `${glyph.vertical}${title}${' '.repeat(gap)}${version}${version === '' ? '' : glyph.vertical}`,
    `${glyph.vertical}${INDENT}${palette.paint('dim', options.subtitle)}`,
    ...(options.notes ?? []).map((note) => `${glyph.vertical}${INDENT}${note}`),
    `${glyph.tee}${palette.paint('muted', glyph.rule.repeat(width))}`,
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
