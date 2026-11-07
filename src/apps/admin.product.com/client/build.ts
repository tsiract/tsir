/**
 * Build the admin SPA.
 *
 * Compiles every `.svelte` component with the Svelte 5 compiler, then bundles
 * the result with Bun's esbuild-based bundler into a single `public/app.js`.
 * Static assets (`index.html`, `logo.svg`, `favicon.svg`) live in `public/` and
 * are served as-is.
 */
import { compile, compileModule, preprocess } from 'svelte/compiler';
import { build, transform } from 'esbuild';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';

const SRC = join(import.meta.dir, 'src');
const OUT = join(import.meta.dir, '..', 'public');
const TMP = join(import.meta.dir, '.build');

/** Walk a directory and return every file matching the predicate. */
function walk(dir: string, pred: (f: string) => boolean, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, pred, acc);
    else if (pred(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * Extract every imported binding name from TypeScript source so we can emit a
 * dummy reference before esbuild strips types. esbuild drops imports that are
 * never referenced in the script body — but Svelte components only used in the
 * template (e.g. `<Layout>`) are "unused" as far as esbuild can see. Keeping a
 * reference ensures the binding survives into the compiled output.
 */
function collectImportNames(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    let clause = m[1].trim();
    // `import type { ... }` is entirely type-only; skip it.
    if (clause.startsWith('type ')) continue;
    // Namespace import: `* as ns`
    const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (ns) {
      names.add(ns[1]);
      continue;
    }
    // Default + named: `Foo, { a, b }` or just `Foo` or just `{ a, b }`
    const parts = clause.split(',');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (part.startsWith('{')) {
        // Named imports block (may span multiple parts if split inside braces)
        const block = parts.slice(i).join(',').trim();
        const inner = block.replace(/[{}]/g, '');
        for (const spec of inner.split(',')) {
          const trimmed = spec.trim();
          // Skip type-only imports (`type Foo`) — they are erased by esbuild
          // and must not be referenced as values in the keep-imports shim.
          if (trimmed.startsWith('type ')) continue;
          const name = trimmed
            .split(/\s+as\s+/)
            .pop()
            ?.trim();
          if (name) names.add(name);
        }
        break;
      }
      if (part) names.add(part);
    }
  }
  return [...names];
}

/** Append a no-op reference to every import so esbuild does not drop it. */
function keepImports(content: string): string {
  const names = collectImportNames(content);
  if (names.length === 0) return content;
  // The unique marker lets us strip only this shim after Svelte compilation,
  // never a legitimate `void [ ... ]` expression in the source.
  return content + `\n/*__TSIR_KEEP_IMPORTS__*/ void [${names.join(', ')}];\n`;
}

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  if (existsSync(TMP)) {
    // Wipe the temp dir so stale components don't leak into the bundle.
    const { rmSync } = await import('node:fs');
    rmSync(TMP, { recursive: true, force: true });
  }
  mkdirSync(TMP, { recursive: true });

  // Compile Svelte components (`.svelte`) and runes modules (`.svelte.ts`) into the
  // temp dir, mirroring the source tree.
  const svelteFiles = walk(SRC, (f) => f.endsWith('.svelte') || f.endsWith('.svelte.ts'));
  for (const file of svelteFiles) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(SRC, file);
    const outPath = join(TMP, rel.replace(/\.svelte(\.ts)?$/u, '.js'));
    mkdirSync(dirname(outPath), { recursive: true });

    if (file.endsWith('.svelte.ts')) {
      // `.svelte.ts` modules use runes; strip TypeScript then compileModule.
      const { code: stripped } = await transform(keepImports(source), { loader: 'ts' });
      const result = compileModule(stripped, {
        filename: rel,
        generate: 'client',
      });
      writeFileSync(outPath, result.js.code, 'utf8');
      continue;
    }

    // Strip TypeScript from `<script lang="ts">` blocks before compiling.
    const preprocessed = await preprocess(
      source,
      {
        script: async ({ content, attributes }) => {
          if (attributes.lang === 'ts') {
            // Append a dummy reference to every import so esbuild does not drop
            // bindings that are only used in the Svelte template (e.g. `<Layout>`).
            const { code } = await transform(keepImports(content), { loader: 'ts' });
            return { code };
          }
          return { code: content };
        },
      },
      { filename: rel },
    );

    const result = compile(preprocessed.code, {
      filename: rel,
      generate: 'client',
      css: 'injected',
    });
    writeFileSync(outPath, result.js.code, 'utf8');
  }

  // Copy non-Svelte sources (TS, CSS) into the temp dir, rewriting `.svelte`
  // and `.svelte.ts` imports to `.js` so esbuild can resolve them.
  const tsFiles = walk(SRC, (f) => f.endsWith('.ts') && !f.endsWith('.svelte.ts'));
  for (const file of tsFiles) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(SRC, file);
    const outPath = join(TMP, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    const rewritten = source
      .replace(/from\s+['"]([^'"]+)\.svelte['"]/gu, "from '$1.js'")
      .replace(/from\s+['"]([^'"]+)\.svelte\.ts['"]/gu, "from '$1.js'");
    writeFileSync(outPath, rewritten, 'utf8');
  }

  // Rewrite `.svelte` / `.svelte.ts` imports in every compiled `.js` file in the
  // temp dir so esbuild can resolve them. Also strip the `void [ ... ]`
  // keep-imports shim injected before esbuild — by this point the Svelte
  // compiler has emitted real usages of each template-only import, so the shim
  // is no longer needed and would confuse the minifier into dropping them.
  const allJs = walk(TMP, (f) => f.endsWith('.js'));
  for (const file of allJs) {
    const src = readFileSync(file, 'utf8');
    const rewritten = src
      .replace(/from\s+['"]([^'"]+)\.svelte\.ts['"]/gu, "from '$1.js'")
      .replace(/from\s+['"]([^'"]+)\.svelte['"]/gu, "from '$1.js'")
      // Remove only the injected keep-imports shim (uniquely marked).
      .replace(/\/\*__TSIR_KEEP_IMPORTS__\*\/\s*void\s*\[[\s\S]*?\];\s*/gu, '');
    if (rewritten !== src) writeFileSync(file, rewritten, 'utf8');
  }

  // Bundle the entry into a single file.
  //
  // We use esbuild (not Bun.build) for the final bundle: Bun's minifier was
  // observed to drop imports that are only referenced inside Svelte-generated
  // rendering closures (e.g. the `<Layout>` component in App.svelte), producing
  // `ReferenceError: Layout is not defined` at runtime. esbuild's minifier
  // handles this correctly.
  const entry = join(TMP, 'main.ts');
  const result = await build({
    entryPoints: [entry],
    outfile: join(OUT, 'app.js'),
    bundle: true,
    target: 'es2020',
    format: 'esm',
    minify: true,
    sourcemap: true,
  });

  if (result.errors.length > 0) {
    for (const log of result.errors) console.error(log);
    process.exit(1);
  }

  console.log(`✓ built public/app.js (${svelteFiles.length} component(s))`);
}

await main();
