/**
 * `configDir` implementation — reads a `config/` directory and merges each
 * file's default export under its filename key.
 *
 * Lives in `adapters/` because it uses `node:fs`/`node:path`/`node:url`.
 * The public `@tsir/config` barrel re-exports `configDir` from here.
 */

export async function configDir(dir: string): Promise<Record<string, unknown>> {
  const { readdirSync } = await import('node:fs');
  const { join, extname } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const files = readdirSync(dir).filter((f) => /\.(ts|js|mjs|cjs)$/u.test(f));
  const merged: Record<string, unknown> = {};

  for (const file of files) {
    const key = file.slice(0, -extname(file).length);
    if (key === '' || key.startsWith('_') || key.startsWith('.')) continue;
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as {
      default?: unknown;
    };
    merged[key] = mod.default;
  }

  return merged;
}
