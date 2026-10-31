/**
 * Managed regions (`CFG-120`).
 *
 * The interesting half is the refusals: a fence that does not pair, a nested region, a
 * duplicated id. Each of those means two possible owners of the same lines, and a tool that
 * resolves that ambiguity by guessing is a tool that eventually deletes a `deploy` block
 * somebody hand-tuned.
 */

import { describe, expect, test } from 'bun:test';

import {
  applyManagedRegion,
  diffLines,
  fence,
  formatDiff,
  hasManagedRegion,
  managedRegions,
  regionBody,
  removeManagedRegion,
  renderRegion,
} from './managed.ts';

const PROJECT = ['export default {', '  app: { name: "x", entry: "./src/app.ts" },', '};'].join(
  '\n',
);

const WITH_REGION = [
  'export default {',
  '  // ── managed:deploy:start ─────────────',
  '  deploy: { topology: "separate" },',
  '  // ── managed:deploy:end ───────────────',
  '  app: { name: "x" },',
  '};',
].join('\n');

describe('reading regions', () => {
  test('the documented fences are found, with their line indexes', () => {
    const [region] = managedRegions(WITH_REGION);

    expect(region?.id).toBe('deploy');
    expect(region?.start).toBe(1);
    expect(region?.end).toBe(3);
    expect(region?.indent).toBe('  ');
  });

  test('the plain `// managed:id:start` form is a fence too', () => {
    const source = ['// managed:deploy:start', 'x', '// managed:deploy:end'].join('\n');

    expect(managedRegions(source).map((region) => region.id)).toEqual(['deploy']);
  });

  test('several regions, several ids', () => {
    const source = [
      '// ── managed:routes:start ──',
      '// ── managed:routes:end ──',
      '// ── managed:deploy:start ──',
      '// ── managed:deploy:end ──',
    ].join('\n');

    expect(managedRegions(source).map((region) => region.id)).toEqual(['routes', 'deploy']);
  });

  test('a file with no regions is not an error', () => {
    expect(managedRegions(PROJECT)).toEqual([]);
    expect(hasManagedRegion(PROJECT, 'deploy')).toBe(false);
    expect(regionBody(WITH_REGION, 'deploy')).toBe('  deploy: { topology: "separate" },');
    expect(regionBody(WITH_REGION, 'routes')).toBeUndefined();
  });
});

describe('refusals', () => {
  test('an unclosed region names the line', () => {
    expect(() => managedRegions('// ── managed:deploy:start ──\nx')).toThrow(/never closed/u);
    expect(() => managedRegions('// ── managed:deploy:start ──\nx')).toThrow(/line 1/u);
  });

  test('a stray end fence is a refusal, not a no-op', () => {
    expect(() => managedRegions('x\n// ── managed:deploy:end ──')).toThrow(/nothing is open/u);
  });

  test('mismatched ids are a refusal', () => {
    expect(() =>
      managedRegions(['// ── managed:deploy:start ──', '// ── managed:routes:end ──'].join('\n')),
    ).toThrow(/closed by managed:routes/u);
  });

  test('nested regions are a refusal', () => {
    const source = [
      '// ── managed:deploy:start ──',
      '// ── managed:routes:start ──',
      '// ── managed:routes:end ──',
      '// ── managed:deploy:end ──',
    ].join('\n');

    expect(() => managedRegions(source)).toThrow(/nested inside managed:deploy/u);
  });

  test('a duplicated id is a refusal', () => {
    const source = [
      '// ── managed:deploy:start ──',
      '// ── managed:deploy:end ──',
      '// ── managed:deploy:start ──',
      '// ── managed:deploy:end ──',
    ].join('\n');

    expect(() => managedRegions(source)).toThrow(/appears twice/u);
  });

  test('every refusal carries the config code and a way out', () => {
    try {
      managedRegions('// ── managed:deploy:start ──');
    } catch (error: unknown) {
      const tsir = error as { code?: string; hint?: string; kind?: string };
      expect(tsir.code).toBe('CFG_MANAGED_REGION_INVALID');
      expect(tsir.kind).toBe('config');
      expect(tsir.hint).toContain(':end');
    }
  });
});

describe('writing regions', () => {
  test('replacing keeps the fence indentation and the rest of the file', () => {
    const after = applyManagedRegion(WITH_REGION, 'deploy', ['deploy: { topology: "single" },']);

    expect(after).toContain('  deploy: { topology: "single" },');
    expect(after).not.toContain('separate');
    expect(after).toContain('  app: { name: "x" },');
  });

  test('a second identical write is a no-op — that is what makes `--plan` a check', () => {
    const once = applyManagedRegion(PROJECT, 'deploy', ['deploy: { topology: "single" },']);
    const twice = applyManagedRegion(once, 'deploy', ['deploy: { topology: "single" },']);

    expect(twice).toBe(once);
  });

  test('a missing region is appended inside the default export, before its closing brace', () => {
    const after = applyManagedRegion(PROJECT, 'deploy', ['deploy: { topology: "single" },']);
    const lines = after.split('\n');

    expect(lines[0]).toBe('export default {');
    expect(lines.at(-1)).toBe('};');
    expect(lines.at(-2)).toContain('managed:deploy:end');
    // Still inside the object: the fence is before the final `};`, not after it.
    expect(after.indexOf('managed:deploy:start')).toBeLessThan(after.lastIndexOf('};'));
  });

  test('the body is indented relative to the fence, at any depth', () => {
    const nested = ['const config = defineConfig(', '  {', '  }', ');'].join('\n');
    expect(() => applyManagedRegion(nested, 'deploy', ['x'])).toThrow(/no `export default \{`/u);

    const indented = ['function make() {', '  export default {', '  };', '}'].join('\n');
    expect(applyManagedRegion(indented, 'deploy', ['x'])).toContain('  // ── managed:deploy:start');
  });

  test('removing a region takes its fences and nothing else', () => {
    const after = removeManagedRegion(WITH_REGION, 'deploy');

    expect(after).not.toContain('managed:deploy');
    expect(after).toContain('  app: { name: "x" },');
    expect(removeManagedRegion(PROJECT, 'deploy')).toBe(PROJECT);
  });

  test('rendering pads the fence, and both markers fit on one line', () => {
    const rendered = renderRegion('deploy', ['deploy: {}']).split('\n');

    expect(rendered[0]).toStartWith('  // ── managed:deploy:start ─');
    expect(rendered.at(-1)).toStartWith('  // ── managed:deploy:end ─');
    // Both fences are padded to the same width, which is what makes them line up in review.
    expect(fence('deploy', 'start').length).toBe(fence('deploy', 'end').length);
  });
});

describe('the plan diff', () => {
  test('equal texts have no hunk', () => {
    expect(diffLines(PROJECT, PROJECT)).toEqual({ removed: [], added: [], at: -1 });
    expect(formatDiff(PROJECT, PROJECT)).toBe('  (no change)\n');
  });

  test('a region change is one removed block and one added block', () => {
    const diff = diffLines(WITH_REGION, applyManagedRegion(WITH_REGION, 'deploy', ['deploy: {}']));

    expect(diff.at).toBe(2);
    expect(diff.removed).toEqual(['  deploy: { topology: "separate" },']);
    expect(diff.added.some((line) => line.includes('deploy: {}'))).toBe(true);
  });

  test('the printed diff marks both sides', () => {
    const text = formatDiff(PROJECT, `${PROJECT}\n// tail`);

    expect(text).toContain('  + // tail');
    expect(text.startsWith('  -')).toBe(false);
  });
});
