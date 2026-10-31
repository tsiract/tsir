/**
 * Lifecycle commands: dev, start, build.
 *
 * Phase 1 has no HTTP surface yet, so `dev` boots the application, reports the
 * lifecycle it went through, and waits for a signal. That is deliberately
 * honest: it exercises the same bootstrap production will use rather than
 * pretending a server exists.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { configSchemaDocument } from '@tsir/config';
import type { AppDiagnosticEvent } from '@tsir/core';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { bootstrapWarnings, readBootstrapRecord, readPresetRecords } from '../bootstrap-record.ts';
import { DRIVERS_MODULE, planDrivers, renderDriversModule } from '../drivers.ts';
import { bootProject, loadProject, type BootedProject } from '../project.ts';
import { EXIT, fail, info, jsonDocument, ok, style } from '../output.ts';

export async function devCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });
  const json = boolFlag(args, '--json');

  const project = await loadProject(process.cwd());
  const diagnostics: AppDiagnosticEvent[] = [];

  const { app } = await bootProject(project, {
    mode: 'development',
    onDiagnostic: (event) => diagnostics.push(event),
  });

  if (json) {
    info(
      jsonDocument({
        ok: true,
        app: app.appName,
        state: app.state.kind,
        target: app.capabilities.target,
        capabilities: app.capabilities.list,
        providers: app.container.describe().length,
        diagnostics,
      }),
    );
  } else {
    info('');
    info(`  ${style.bold('tsir dev')} ${style.dim('· phase 1 — no HTTP surface yet')}`);
    info('');
    info(`  ${style.green('➜')}  app        ${app.appName}`);
    info(`  ${style.green('➜')}  state      ${app.state.kind}`);
    info(
      `  ${style.green('➜')}  target     ${app.capabilities.target} (${app.capabilities.list.join(', ')})`,
    );
    info(`  ${style.green('➜')}  providers  ${String(app.container.describe().length)}`);
    for (const entry of app.container.describe()) {
      info(`     ${style.dim('·')} ${entry.token} ${style.dim(`${entry.lifetime} ${entry.kind}`)}`);
    }
    info('');
    info(`  ${style.dim('routes, middleware and validation arrive in Phase 2')}`);
    info(`  ${style.dim('press ctrl-c to shut down gracefully')}`);
    info('');
  }

  await waitForShutdown(app);
  return EXIT.ok;
}

/**
 * CLI-007: `tsir start` boots the artifact `tsir build` wrote, not the source. Production boot
 * never reflects over modules. It reads `.tsir/manifest.json`, and core refuses to start when that
 * file is missing (`APP_MANIFEST_MISSING`) or no longer matches the modules
 * (`APP_MANIFEST_STALE`). Both errors already carry the `tsir build` hint, so they pass through.
 */
export async function startCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });
  const json = boolFlag(args, '--json');

  const project = await loadProject(process.cwd());
  // CFG-105: read the bootstrap record on start. Drift is reported, never fatal.
  if (!json) {
    const warnings = bootstrapWarnings(
      await readBootstrapRecord(project.root),
      await readPresetRecords(project.configPath),
    );
    for (const warning of warnings) info(`  ${style.dim('warn')} ${warning}`);
  }
  const diagnostics: AppDiagnosticEvent[] = [];

  let booted: Awaited<ReturnType<typeof bootProject>>;
  try {
    booted = await bootProject(project, {
      mode: 'production',
      onDiagnostic: (event) => diagnostics.push(event),
    });
  } catch (error) {
    return fail(error, json);
  }
  const { app } = booted;

  if (json) {
    info(
      jsonDocument({
        ok: true,
        mode: 'production',
        app: app.appName,
        state: app.state.kind,
        target: app.capabilities.target,
        providers: app.container.describe().length,
        diagnostics,
      }),
    );
  } else {
    info('');
    info(`  ${style.bold('tsir start')} ${style.dim('· built artifact')}`);
    info('');
    info(`  ${style.green('➜')}  app        ${app.appName}`);
    info(`  ${style.green('➜')}  state      ${app.state.kind}`);
    info(`  ${style.green('➜')}  target     ${app.capabilities.target}`);
    info(`  ${style.green('➜')}  providers  ${String(app.container.describe().length)}`);
    info('');
    info(`  ${style.dim('press ctrl-c to shut down gracefully')}`);
    info('');
  }

  await waitForShutdown(app);
  return EXIT.ok;
}

async function waitForShutdown(app: BootedProject['app']): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      info(`\n  ${style.dim('·')} ${signal} received — shutting down`);
      void app.shutdown('signal').then(
        () => {
          ok('application stopped');
          resolve();
        },
        (error: unknown) => {
          info(
            `  ${style.red('✗')} shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          resolve();
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function buildCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--out': { type: 'string', description: 'output directory', default: '.tsir' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const project = await loadProject(process.cwd());

  // `drivers.gen.ts` (`CAP-003`): one import per driver the configuration declares, and a
  // refusal — not a warning — for a driver this build does not ship. Checked **before** anything
  // is written: a half-written `.tsir/` that looks like a successful build is worse than none.
  const plan = planDrivers({
    ...(project.config.cache === undefined ? {} : { cache: project.config.cache }),
    ...(project.config.queue === undefined ? {} : { queue: project.config.queue }),
  });
  if (plan.problems.length > 0) {
    for (const problem of plan.problems) info(`✗ ${problem.message}`);
    return fail(
      new Error(
        `${String(plan.problems.length)} driver(s) declared but not shipped — nothing was written`,
      ),
      boolFlag(args, '--json'),
    );
  }

  const manifest = project.app.manifest();
  const outDir = join(project.root, stringFlag(args, '--out') ?? '.tsir');
  await mkdir(outDir, { recursive: true });

  const manifestPath = join(outDir, 'manifest.json');
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const driversPath = join(outDir, DRIVERS_MODULE);
  await Bun.write(driversPath, renderDriversModule(plan));

  if (boolFlag(args, '--json')) {
    info(
      jsonDocument({
        ok: true,
        manifest: manifestPath.replace(project.root, '.'),
        drivers: {
          path: driversPath.replace(project.root, '.'),
          imports: plan.uses.map((use) => ({
            port: use.port,
            driver: use.driver,
            names: use.names,
            module: use.module,
          })),
        },
        ...manifest,
      }),
    );
    return EXIT.ok;
  }

  ok(`manifest written to ${manifestPath.slice(project.root.length + 1)}`);
  info(
    `  ${style.dim('drivers')}  ${String(plan.uses.length)} import(s) in ${driversPath.slice(project.root.length + 1)}`,
  );
  info(`  ${style.dim('app')}       ${manifest.appName}`);
  info(`  ${style.dim('modules')}   ${manifest.modules.join(', ')}`);
  info(`  ${style.dim('providers')} ${String(manifest.providerCount)}`);
  info(`  ${style.dim('hash')}      ${manifest.sourceHash}`);
  info(
    `\n  ${style.dim('production boot consumes this file; routes and deploy units join it in Phases 2 and 6.')}`,
  );
  return EXIT.ok;
}

export async function configDumpCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const project = await loadProject(process.cwd());
  const config = project.app.load({ mode: 'development' });

  if (boolFlag(args, '--json')) {
    // `values` is the masked view: secrets are replaced before they reach this document.
    // CFG-116: the schema travels with the values, so a machine can read both from one document.
    info(
      jsonDocument({
        ok: true,
        app: project.config.app.name,
        values: config.masked,
        schema: configSchemaDocument(project.app.configSpec),
      }),
    );
    return EXIT.ok;
  }

  info('');
  info(
    `  ${style.bold('configuration')} ${style.dim(`· ${project.config.app.name} (secrets redacted)`)}`,
  );
  info('');
  for (const [key, value] of Object.entries(config.masked)) {
    info(`  ${key.padEnd(22)} ${String(value)}`);
  }
  for (const warning of config.warnings) {
    info(`  ${style.yellow('!')} ${warning}`);
  }
  info('');
  return EXIT.ok;
}
