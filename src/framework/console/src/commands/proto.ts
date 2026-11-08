/**
 * `tsir proto:generate` — compile an application's `.proto` files into typed TypeScript.
 *
 * This is the application-level half of the split the repository already made for its own use:
 * the framework's `proto/` is compiled by `make proto` into `@tsir/link`'s committed contracts, while
 * an *application's* contracts are its own and must not need the framework repository to
 * regenerate. Same engine (`buf`), same generator (`protoc-gen-es`), different owner.
 *
 * Three decisions worth stating:
 *
 *   1. **`buf` is required, not vendored.** It is one Go binary, and re-implementing proto
 *      compilation would be the "second implementation" this refactor forbids. When it is missing the
 *      command says how to install it and exits with an environment error — it never silently
 *      produces nothing.
 *   2. **Generated code is committed.** A deploy must not need `buf`, and a service must not parse a
 *      `.proto` at runtime. That is the same contract `make proto-check` enforces inside the
 *      repository, so an application gets the same property.
 *   3. **No `.proto`, no failure.** An application without gRPC contracts is a valid application.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { CliError, EXIT, fail, info, jsonDocument, ok, style } from '../output.ts';
import { loadProject } from '../project.ts';

/** Where an application keeps its compiled contracts, by convention. */
const DEFAULT_OUT = 'src/contracts';

function protoFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...protoFiles(path, base));
    else if (entry.name.endsWith('.proto')) found.push(relative(base, path));
  }
  return found;
}

/** Finds an executable on `PATH` without relying on `which`, and without a shell. */
function onPath(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

// buf v2's own words: the module is the input, and `--path` *filters* it. Declaring `proto/` as the
// module and then passing it as the input fails both ways round — the two attempts this file made
// before the real binary was asked.
const MODULE_CONFIG = ['version: v2', 'modules:', '  - path: .', ''].join('\n');

function generatorConfig(outDir: string): string {
  return [
    'version: v2',
    'plugins:',
    '  # protoc-gen-es is the generator @bufbuild/protobuf ships; it resolves from the',
    "  # application's own node_modules, so it is a devDependency and never a global install.",
    '  - local: ./node_modules/.bin/protoc-gen-es',
    `    out: ${outDir}`,
    '    opt: target=ts',
    '',
  ].join('\n');
}

/** Compares two directory trees by file content, so `--check` reports drift rather than a timestamp. */
function differences(a: string, b: string): string[] {
  const list = (dir: string, base = dir): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const path = join(dir, entry.name);
          return entry.isDirectory() ? list(path, base) : [relative(base, path)];
        })
      : [];
  const left = list(a);
  const right = new Set(list(b));
  const drifted = left.filter((file) => {
    if (!right.has(file)) return true;
    return !readFileSync(join(a, file)).equals(readFileSync(join(b, file)));
  });
  const added = [...right].filter((file) => !left.includes(file));
  return [...drifted, ...added].sort();
}

export async function protoGenerateCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--out': { type: 'string', description: `generated TypeScript (default: ./${DEFAULT_OUT})` },
    '--check': { type: 'boolean', description: 'fail if the committed output is stale' },
    '--json': { type: 'boolean', description: 'machine-readable result' },
  });
  const json = boolFlag(args, '--json');
  const check = boolFlag(args, '--check');

  let root: string;
  try {
    ({ root } = await loadProject(process.cwd()));
  } catch (error: unknown) {
    return fail(error, json);
  }

  const protoDir = resolve(root, 'proto');
  const files = protoFiles(protoDir);
  if (files.length === 0) {
    // An application without contracts is not broken. Say so once, and succeed.
    if (json) {
      info(jsonDocument({ protoFiles: 0, generated: false, reason: 'no .proto files' }));
      return EXIT.ok;
    }
    info(`  ${style.yellow('!')} no .proto files under proto/ — nothing to generate`);
    return EXIT.ok;
  }

  const buf = onPath('buf');
  if (buf === undefined) {
    return fail(
      new CliError(
        'buf is not installed',
        EXIT.environment,
        'install it (`go install github.com/bufbuild/buf/cmd/buf@latest` or `brew install bufbuild/buf/buf`); proto compilation needs it',
      ),
      json,
    );
  }
  if (!existsSync(join(root, 'node_modules', '.bin', 'protoc-gen-es'))) {
    return fail(
      new CliError(
        'the protoc-gen-es generator is missing',
        EXIT.environment,
        `add it to this application (bun add -d @bufbuild/protoc-gen-es), then run this again`,
      ),
      json,
    );
  }

  // `buf` reads its config from files, so the two it needs are written under `.tsir/` — a directory
  // that is already ignored — rather than into the project root where they would look like settings
  // the developer is expected to maintain.
  const work = join(root, '.tsir');
  mkdirSync(work, { recursive: true });
  const moduleConfigPath = join(work, 'buf.yaml');
  const templatePath = join(work, 'buf.gen.yaml');
  await Bun.write(moduleConfigPath, MODULE_CONFIG);

  const outDir = resolve(root, stringFlag(args, '--out') ?? DEFAULT_OUT);
  const target = check ? join(work, 'proto-check') : outDir;
  if (check) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  await Bun.write(templatePath, generatorConfig(relative(root, target).split('\\').join('/')));

  const generated = Bun.spawnSync(
    [
      buf,
      'generate',
      '--config',
      moduleConfigPath,
      '--template',
      templatePath,
      '.',
      '--path',
      'proto',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if (generated.exitCode !== 0) {
    const detail = `${generated.stderr.toString()}${generated.stdout.toString()}`.trim();
    return fail(
      new CliError(
        'proto generation failed',
        EXIT.failure,
        detail.split('\n').slice(0, 5).join('\n') || 'buf reported no detail',
      ),
      json,
    );
  }

  if (check) {
    const drifted = differences(outDir, target);
    rmSync(target, { recursive: true, force: true });
    if (drifted.length > 0) {
      return fail(
        new CliError(
          `generated proto output is stale (${String(drifted.length)} file(s))`,
          EXIT.failure,
          `${drifted.slice(0, 3).join(', ')}${drifted.length > 3 ? ', …' : ''} — run tsir proto:generate and commit the result`,
        ),
        json,
      );
    }
    if (json) {
      info(jsonDocument({ protoFiles: files.length, generated: true, stale: false }));
      return EXIT.ok;
    }
    ok(`proto output is current (${String(files.length)} .proto file(s))`);
    return EXIT.ok;
  }

  if (json) {
    info(jsonDocument({ protoFiles: files.length, generated: true, out: relative(root, outDir) }));
    return EXIT.ok;
  }
  ok(`${String(files.length)} .proto file(s) compiled to ${style.cyan(relative(root, outDir))}`);
  info(`  ${style.dim('commit the generated files: a deploy must not need buf')}`);
  return EXIT.ok;
}
