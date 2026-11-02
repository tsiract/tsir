import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const guides = join(root, 'src/docs/guides');
const scratch = join(root, 'build/guide-examples');

/** Mark runnable, standalone snippets explicitly; illustrative fragments stay unmarked. */
describe('hands-on documentation examples', () => {
  test('verified examples typecheck and run against the workspace', () => {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const files: string[] = [];
    for (const page of readdirSync(guides)
      .filter((name) => name.endsWith('.md'))
      .sort()) {
      const markdown = readFileSync(join(guides, page), 'utf8');
      const examples = [...markdown.matchAll(/```ts verify\n([\s\S]*?)```/gu)];
      for (const [index, match] of examples.entries()) {
        const file = join(scratch, `${page.slice(0, -3)}-${String(index)}.ts`);
        const source = (match[1] ?? '')
          .replace(
            /from '@tsir\/([a-z-]+)(\/[a-z/-]+)?'/gu,
            (whole, name: string, sub: string | undefined) => {
              const dir = join(root, 'src/framework', name);
              const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
                exports: Record<string, { default: string }>;
              };
              const entry = manifest.exports[sub === undefined ? '.' : `.${sub}`];
              return entry === undefined ? whole : `from '${join(dir, entry.default)}'`;
            },
          )
          .replace(
            /from 'drizzle-orm([^']*)'/gu,
            (_whole, sub: string) =>
              `from '${join(root, 'src/framework/database/node_modules/drizzle-orm')}${sub}'`,
          );
        writeFileSync(file, source);
        files.push(file);
      }
    }
    expect(files.length).toBeGreaterThanOrEqual(5);
    writeFileSync(
      join(scratch, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { types: ['bun'] },
        include: ['*.ts'],
      }),
    );
    const typecheck = Bun.spawnSync(
      [
        process.execPath,
        join(root, 'node_modules/typescript/bin/tsc'),
        '-p',
        join(scratch, 'tsconfig.json'),
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(`${typecheck.stdout.toString()}${typecheck.stderr.toString()}`).toBe('');
    expect(typecheck.exitCode).toBe(0);
    for (const file of files) {
      const run = Bun.spawnSync([process.execPath, file], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(`${file}: ${run.stderr.toString()}`).toBe(`${file}: `);
      expect(run.exitCode).toBe(0);
    }
  }, 60_000);
});
