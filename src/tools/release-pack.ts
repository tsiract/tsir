/**
 * `make release-pack` — turn `dist/` into release artifacts.
 *
 * Produces, under `dist/release/`:
 *
 *   tarballs/tsir-<pkg>-<version>.tgz   one npm-installable tarball per package
 *   tsir-<version>-dist.tar.gz          the whole distributable tree ("dist in code")
 *   SHA256SUMS.txt                      checksums for everything above
 *   release-manifest.json              version, commit-ish, sizes, checksums
 *
 * Two artifact shapes on purpose:
 *
 *   - **Tarballs** are what `npm install tsir-<pkg>-0.0.0.tgz` consumes, and what a
 *     registry publish would upload. They contain only the `files` listed in the
 *     distributed manifest.
 *   - **The dist tree** is for vendoring, reviewing, or diffing a release without
 *     installing anything — the thing a maintainer attaches to a GitHub Release.
 *
 * The tool does not trust the packer: after packing it installs every tarball into
 * an isolated project and boots an application from them. A release that cannot
 * boot from its own artifacts never gets a manifest written.
 *
 * Usage: bun src/tools/release-pack.ts [--skip-verify]
 */

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyAppJourney } from './verify-app-journey.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const DIST = join(ROOT, 'dist');
const RELEASE = join(DIST, 'release');
const TARBALLS = join(RELEASE, 'tarballs');
const SANDBOX = join(ROOT, '.verify', 'release');

const SKIP_VERIFY = Bun.argv.includes('--skip-verify');

const failures: string[] = [];
const steps: string[] = [];

/** `@tsir/core` → `tsir-core`; npm tarball names cannot contain `/` or `@`. */
function tarballName(pkgName: string, version: string): string {
  return `${pkgName.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function run(command: readonly string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const result = Bun.spawnSync([...command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

interface PackedPackage {
  readonly name: string;
  readonly version: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Packs one already-built package directory into an installable tarball. */
async function packPackage(dir: string): Promise<PackedPackage | undefined> {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
  };
  const name = manifest.name;
  const version = manifest.version;
  if (name === undefined || version === undefined) {
    failures.push(`${dir}: manifest is missing name or version`);
    return undefined;
  }

  // `bun pm pack` honours the manifest's `files` list, which `make dist` generates.
  const result = await run([process.execPath, 'pm', 'pack', '--destination', TARBALLS], dir);
  if (!result.ok) {
    failures.push(`${name}: pack failed\n${result.out.split('\n').slice(0, 5).join('\n')}`);
    return undefined;
  }

  const produced = join(TARBALLS, tarballName(name, version));
  if (!(await stat(produced).catch(() => undefined))) {
    failures.push(`${name}: pack did not produce ${basename(produced)}`);
    return undefined;
  }

  const bytes = (await stat(produced)).size;
  return { name, version, file: produced, bytes, sha256: await sha256(produced) };
}

/**
 * Installs the packed tarballs into a fresh project and boots an app from them.
 *
 * This is the difference between "we produced a file" and "the file works".
 */
async function verifyTarballs(packed: readonly PackedPackage[]): Promise<void> {
  await rm(SANDBOX, { recursive: true, force: true });
  await mkdir(SANDBOX, { recursive: true });

  // Transitive `@tsir/*` dependencies point at the registry, where nothing is
  // published yet. `dependencies` + `overrides` pinned to the tarballs make the
  // install resolve exactly as it would once the packages exist in a registry.
  const local = Object.fromEntries(
    packed.map((entry) => [entry.name, `file:${entry.file}`]),
  ) as Record<string, string>;
  await writeFile(
    join(SANDBOX, 'package.json'),
    `${JSON.stringify(
      {
        name: 'tsir-release-verify',
        private: true,
        type: 'module',
        dependencies: local,
        overrides: local,
      },
      null,
      2,
    )}\n`,
  );

  const install = await run([process.execPath, 'install', '--no-cache'], SANDBOX);
  if (!install.ok) {
    failures.push(`tarball install failed\n${install.out.split('\n').slice(0, 8).join('\n')}`);
    return;
  }
  steps.push(`installed ${String(packed.length)} tarballs into a clean project`);

  await writeFile(
    join(SANDBOX, 'boot.ts'),
    `import { bootstrap, defineModule } from '@tsir/core';\n` +
      `import { defineConfig, env, loadConfig } from '@tsir/config';\n` +
      `import * as m from '@tsir/validate/mini';\n` +
      `import { validateSync } from '@tsir/validate';\n` +
      `const spec = defineConfig({ APP_ENV: env.string({ default: 'production' }) });\n` +
      `const config = loadConfig(spec, { env: {} });\n` +
      `const ok = validateSync(m.object({ name: m.string() }), { name: 'tsir' });\n` +
      `const app = await bootstrap({ appName: 'release', config, modules: [defineModule({ name: 'release' })] });\n` +
      `if (app.state.kind !== 'ready') throw new Error('not ready');\n` +
      `await app.shutdown('manual');\n` +
      `if (!ok.ok) throw new Error('validation failed');\n` +
      `console.log('TARBALL_BOOT_OK');\n`,
  );

  const boot = await run([process.execPath, 'run', join(SANDBOX, 'boot.ts')], SANDBOX);
  if (!boot.ok || !boot.out.includes('TARBALL_BOOT_OK')) {
    failures.push(`tarball boot failed\n${boot.out.split('\n').slice(0, 8).join('\n')}`);
    return;
  }
  steps.push('booted an app from the installed tarballs (ready → stopped)');

  // The installed package's bin must point to emitted JavaScript, not src/cli.ts.
  const cli = await run(
    [process.execPath, join(SANDBOX, 'node_modules', '.bin', 'tsir'), '--help'],
    SANDBOX,
  );
  if (!cli.ok || !cli.out.includes('tsir')) {
    failures.push(`installed tsir CLI failed\n${cli.out.split('\n').slice(0, 8).join('\n')}`);
    return;
  }
  steps.push('installed tsir CLI runs from the packed binary');

  // No tarball may ship test code, type tests, or TypeScript sources.
  for (const entry of packed) {
    const listed = await run(['tar', '-tzf', entry.file], ROOT);
    // `.d.ts` is a *feature* of the distribution; a bare `.ts` is a source leak.
    const leaked = listed.out.split('\n').filter((line) => {
      if (/\.(test|spec)\.[cm]?[jt]s$/.test(line)) return true;
      if (line.includes('/type-tests/')) return true;
      return /\.ts$/.test(line) && !line.endsWith('.d.ts');
    });
    if (leaked.length > 0) {
      failures.push(
        `${entry.name}: tarball contains non-distributable files: ${leaked.slice(0, 3).join(', ')}`,
      );
    }
  }
  if (failures.length === 0) steps.push('no test/type-test/TypeScript sources in any tarball');
}

async function main(): Promise<void> {
  await rm(RELEASE, { recursive: true, force: true });
  await mkdir(TARBALLS, { recursive: true });

  const rootManifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  const version = rootManifest.version;

  const frameworkDirs = (await readdir(join(DIST, 'framework'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(DIST, 'framework', entry.name))
    .sort();

  const packed: PackedPackage[] = [];
  for (const dir of frameworkDirs) {
    const result = await packPackage(dir);
    if (result !== undefined) packed.push(result);
  }

  if (!SKIP_VERIFY && failures.length === 0) await verifyTarballs(packed);

  // The "dist in code" artifact: the whole tree, minus the release directory itself.
  const distArchive = join(RELEASE, `tsir-${version}-dist.tar.gz`);
  const tar = await run(
    [
      'tar',
      '--exclude=node_modules',
      '--exclude=*/node_modules',
      '--exclude=.tsir',
      '--exclude=*/.tsir',
      '-czf',
      distArchive,
      '-C',
      DIST,
      'framework',
      'src',
      'frontpage',
      'tsir',
      'README.md',
      'LICENSE',
      'bun.lock',
      'manifest.json',
      'overrides.json',
      'package.json',
      'bin',
    ],
    ROOT,
  );
  if (!tar.ok) failures.push(`dist archive failed\n${tar.out.slice(0, 400)}`);
  if (tar.ok && !SKIP_VERIFY && failures.length === 0) {
    try {
      await verifyAppJourney(distArchive);
      steps.push(
        'scaffolded, served, tested and built an application from the release archive outside the checkout',
      );
    } catch (error) {
      failures.push(
        `application journey failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`);
    process.stderr.write('\n  release-pack aborted; no manifest written\n\n');
    process.exit(1);
  }

  // Paths are relative to `dist/release/`, so `sha256sum -c` (Linux) or
  // `shasum -a 256 -c` (macOS) from that directory
  // work unmodified — the checksum file is only useful if the paths resolve.
  const files = [...packed.map((entry) => entry.file), distArchive];
  const sums = await Promise.all(
    files.map(async (file) => `${await sha256(file)}  ${relative(RELEASE, file)}`),
  );
  await writeFile(join(RELEASE, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

  const manifest = {
    name: 'tsir',
    version,
    generatedAt: new Date().toISOString(),
    // No registry publish yet (Q7): the artifacts are the release.
    published: false,
    tarballs: packed.map((entry) => ({
      name: entry.name,
      version: entry.version,
      file: basename(entry.file),
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    distArchive: {
      file: basename(distArchive),
      bytes: (await stat(distArchive)).size,
      sha256: await sha256(distArchive),
    },
  };
  await writeFile(join(RELEASE, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Ship the MIT notice next to the release archives.
  await copyFile(join(ROOT, 'LICENSE'), join(RELEASE, 'LICENSE'));

  process.stdout.write('\n  release artifacts\n\n');
  for (const entry of packed) {
    process.stdout.write(
      `  ${entry.name.padEnd(18)} ${(entry.bytes / 1024).toFixed(1).padStart(8)} KiB  ${basename(entry.file)}\n`,
    );
  }
  process.stdout.write(
    `  ${'dist tree'.padEnd(18)} ${((await stat(distArchive)).size / 1024).toFixed(1).padStart(8)} KiB  ${basename(distArchive)}\n`,
  );
  process.stdout.write('\n');
  for (const step of steps) process.stdout.write(`  ✓ ${step}\n`);
  process.stdout.write(`\n  ✓ ${RELEASE}/\n\n`);
}

await main();
