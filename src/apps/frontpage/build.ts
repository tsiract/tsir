/**
 * Build the self-contained frontpage (DOC-001, ADR-0029).
 * Tailwind + DaisyUI are build-time tools. Their compiled CSS, the small JS
 * enhancement and tested documentation examples are inlined into one HTML file.
 * `--check` makes the committed artifact a reproducible, drift-checked output.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { groups, packages, renderPackages } from './packages.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const APP = join(ROOT, 'src/apps/frontpage');
const OUTPUT = join(APP, 'public/index.html');

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** A deliberately small tokenizer; no runtime syntax-highlighting dependency. */
export function highlight(code: string): string {
  const tokens =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b(?:import|from|const|let|class|return|await|async|new|for|of|if|else|export|default|function|type|as|unknown|true|false)\b|\b\d[\d_]*(?:\.\d+)?\b)/g;
  let result = '';
  let cursor = 0;
  for (const match of code.matchAll(tokens)) {
    const token = match[0];
    const index = match.index ?? 0;
    result += escapeHtml(code.slice(cursor, index));
    const kind =
      token.startsWith('//') || token.startsWith('/*')
        ? 'comment'
        : /^['"`]/.test(token)
          ? 'string'
          : /^\d/.test(token)
            ? 'number'
            : /^(?:import|from|const|let|class|return|await|async|new|for|of|if|else|export|default|function|type|as|unknown|true|false)$/.test(
                  token,
                )
              ? 'keyword'
              : 'type';
    result += `<span class="token-${kind}">${escapeHtml(token)}</span>`;
    cursor = index + token.length;
  }
  return result + escapeHtml(code.slice(cursor));
}

export function exampleOf(prose: string): string {
  const section = prose.split('## Example')[1]?.split('\n## ')[0] ?? '';
  const code = /```ts\n([\s\S]*?)```/u.exec(section)?.[1];
  if (code === undefined) throw new Error('The frontpage requires a tested TypeScript example.');
  return code.trimEnd();
}

/**
 * Resolves the node binary, falling back to common version-manager locations
 * when `node` is not on `PATH` (non-interactive shells, CI, `make dev`).
 */
function resolveNode(): string {
  const which = spawnSync('which', ['node'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim() !== '') return which.stdout.trim();
  const home = homedir();
  const candidates = [
    join(home, '.nvm/versions/node'),
    join(home, '.local/share/fnm/node-versions'),
    join(home, '.volta/bin/node'),
    join(home, '.asdf/installs/nodejs'),
  ];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    const find = (dir: string): string | null => {
      const bin = join(dir, 'bin/node');
      if (existsSync(bin)) return bin;
      try {
        const entries = readdirSync(dir)
          .map((name) => join(dir, name))
          .filter((path) => statSync(path).isDirectory())
          .sort();
        for (const entry of entries) {
          const found = find(entry);
          if (found !== null) return found;
        }
      } catch {
        /* not a directory — skip */
      }
      return null;
    };
    const found = find(base);
    if (found !== null) return found;
  }
  throw new Error(
    'node not found on PATH and no version-manager install detected. Install Node.js or add it to PATH.',
  );
}

export async function renderFrontpage(root = ROOT): Promise<string> {
  const app = join(root, 'src/apps/frontpage');
  const scratch = join(root, 'build/frontpage');
  await mkdir(scratch, { recursive: true });
  const cssPath = join(scratch, 'styles.css');
  const cli = join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs');
  // Node runs the native Tailwind CLI; Bun runs the repository build and dev server.
  // Resolve node from version managers (nvm/fnm/volta/asdf) when it is not on PATH,
  // so the build works from non-interactive shells such as `make dev`.
  const node = resolveNode();
  const css = Bun.spawnSync([node, cli, '-i', join(app, 'styles.css'), '-o', cssPath, '--minify'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (css.exitCode !== 0) throw new Error(`Tailwind CSS failed: ${css.stderr.toString()}`);
  const script = await Bun.build({
    entrypoints: [join(app, 'client.js')],
    target: 'browser',
    minify: true,
  });
  if (!script.success) throw new Error('Frontpage JavaScript did not compile.');
  const js = await script.outputs[0]?.text();
  if (js === undefined) throw new Error('Frontpage JavaScript output is missing.');
  const [template, styles, ...examples] = await Promise.all([
    readFile(join(app, 'template.html'), 'utf8'),
    readFile(cssPath, 'utf8'),
    ...['http', 'validate', 'database'].map(async (name) =>
      exampleOf(await readFile(join(root, `src/docs/packages/prose/${name}.md`), 'utf8')),
    ),
  ]);
  const [http, validate, database] = examples;
  const filters = groups
    .map(
      (group) =>
        `<button class="btn filter-button" type="button" data-filter="${group.id}" aria-pressed="${group.id === 'all'}">${group.label}</button>`,
    )
    .join('');
  const licenses = await Promise.all(
    ['daisyui', 'tailwindcss'].map((name) =>
      readFile(join(root, `node_modules/${name}/LICENSE`), 'utf8'),
    ),
  );
  const replacements: Readonly<Record<string, string>> = {
    '/* __SITE_CSS__ */': styles.trim(),
    '/* __SITE_JS__ */': js.trim().replace(/<\/script/gi, '<\\/script'),
    '<!-- __CODE_HTTP__ -->': highlight(http ?? ''),
    '<!-- __CODE_VALIDATE__ -->': highlight(validate ?? ''),
    '<!-- __CODE_DATABASE__ -->': highlight(database ?? ''),
    __PACKAGES__: renderPackages(),
    __PACKAGE_COUNT__: String(packages.length),
    __PACKAGE_FILTERS__: filters,
  };
  let html =
    '<!-- Generated by bun run frontpage:build. Edit template.html, styles.css, client.js or packages.ts. -->\n';
  html += template.replace(
    /\/\* __SITE_(?:CSS|JS)__ \*\/|<!-- __CODE_(?:HTTP|VALIDATE|DATABASE)__ -->|__PACKAGES__|__PACKAGE_COUNT__|__PACKAGE_FILTERS__/g,
    (token) => {
      const value = replacements[token];
      if (value === undefined) throw new Error(`Unknown build token: ${token}`);
      return value;
    },
  );
  // Preserve source whitespace inside code, but avoid shipping template indentation.
  html = html
    .split(/(<pre[\s\S]*?<\/pre>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/g)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' '),
    )
    .join('');
  html += `\n<!--\nBundled third-party CSS licenses:\n${licenses.join('\n\n')}\n-->\n`;
  return html;
}

if (import.meta.main) {
  const html = await renderFrontpage();
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > 128 * 1024) throw new Error(`Frontpage exceeds its 128 KiB budget: ${bytes} bytes.`);
  if (Bun.argv.includes('--check')) {
    const current = await readFile(OUTPUT, 'utf8');
    if (current !== html) {
      process.stderr.write(
        'Frontpage artifact is stale. Run `bun run frontpage:build` and commit the result.\n',
      );
      process.exit(1);
    }
    process.stdout.write(`✓ frontpage artifact is current (${String(bytes)} bytes)\n`);
  } else {
    await writeFile(OUTPUT, html);
    process.stdout.write(
      `✓ frontpage built: one file, ${String(bytes)} bytes, no external assets\n`,
    );
  }
}
