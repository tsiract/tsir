/**
 * Vault key commands (`VLT-015`, `VLT-016`).
 *
 * Two rules shape this file:
 *
 *   1. **Nothing is written.** `vault:key:generate` prints a key and stops;
 *      `vault:key:activate` prints the env and manifest a deployment should carry.
 *      Neither touches the repository or the environment of the running shell, so
 *      a second run never silently applies a change the first one half-did.
 *   2. **Material is never echoed a second time.** Generation prints the key once,
 *      because that is the only moment the operator can capture it. Activation does
 *      not print it at all — the new value is the `APP_KEY_NEXT` the operator
 *      already deployed — so the terminal history of a promotion contains key ids
 *      and states, never key bytes (`VLT-027`).
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createRotationStore } from '@tsir/database';
import {
  formatKeySpec,
  generateKey,
  KEY_STATES,
  planActivation,
  planRetire,
  rotationStatus,
  runRotation,
  type KeyState,
  type KeyringEntry,
  type RotationTarget,
  type Vault,
  type VaultAlg,
} from '@tsir/vault';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { loadProject, type LoadedProject } from '../project.ts';
import { CliError, EXIT, info, ok, style, UsageError, warn, jsonDocument } from '../output.ts';
import { bindDatabase } from './db.ts';

/** `tsir vault:key:generate [--alg <alg>] [--json]` */
export async function vaultKeyGenerateCommand(argv: readonly string[]): Promise<number> {
  const { flags } = parseArgs(argv, {
    '--alg': { type: 'string', description: 'algorithm: aes-256-gcm', default: 'aes-256-gcm' },
    '--id': { type: 'string', description: 'key id, e.g. v2 (default: random)' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const alg = String(flags['alg'] ?? 'aes-256-gcm');
  if (alg !== 'aes-256-gcm') {
    throw new UsageError(
      `unknown algorithm "${alg}"`,
      'aes-256-gcm is the only implemented algorithm (xchacha20-poly1305 waits on a vetted library, 06-vault.md § 6)',
    );
  }

  const chosen = typeof flags['id'] === 'string' ? flags['id'].trim() : '';
  const key = generateKey('aes-256-gcm', chosen === '' ? undefined : chosen);
  const spec = formatKeySpec(key);

  if (flags['json'] === true) {
    info(
      jsonDocument({
        ok: true,
        id: key.id,
        alg: key.alg,
        env: { APP_KEY_NOW: spec },
        written: false,
      }),
    );
    return EXIT.ok;
  }

  ok(`generated vault key ${style.bold(key.id)} (${key.alg})`);
  info('');
  info(`APP_KEY_NOW=${spec}`);
  info('');
  warn('this value is shown once and was not written anywhere — store it in your secret manager');
  info(style.dim('deploy it as APP_KEY_NOW, then re-run to rotate onto the next key'));
  return EXIT.ok;
}

interface DeployedManifest {
  readonly keys: readonly KeyringEntry[];
  /**
   * Material for keys the environment does not carry. Read, forwarded to the
   * keyring, and **never printed** — the output of this command is ids and states.
   */
  readonly materials?: Readonly<Record<string, string>> | undefined;
}

/** Reads `TSIR_KEYRING_FILE` (or `--manifest <path>`) as `{ keys: [...], materials }`. */
async function readManifest(path: string | undefined): Promise<DeployedManifest | undefined> {
  if (path === undefined || path.trim() === '') return undefined;

  const text = await readFile(path, 'utf8').then(
    (value) => value,
    (reason: unknown) =>
      // A missing manifest is an environment problem, not a crash: the operator
      // pointed the CLI at a file that is not there.
      Promise.reject(
        new CliError(
          `cannot read the keyring manifest at ${path}: ${(reason as Error).message}`,
          3,
          'TSIR_KEYRING_FILE points at the deployed manifest; unset it for a single-key vault',
        ),
      ),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(
      `${path} is not valid JSON`,
      3,
      'the manifest is {"keys":[{"id","alg","state"}]}',
    );
  }

  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new CliError(
      `${path} has no "keys" array`,
      3,
      'the manifest is {"keys":[{"id","alg","state"}]}',
    );
  }

  const rawMaterials = (parsed as { materials?: unknown }).materials;
  if (rawMaterials !== undefined) {
    if (typeof rawMaterials !== 'object' || rawMaterials === null || Array.isArray(rawMaterials)) {
      throw new CliError(`${path}: "materials" must be an object of id → spec`, 3);
    }
  }

  const entries = keys.map((entry: unknown, index): KeyringEntry => {
    const shaped = entry as { id?: unknown; alg?: unknown; state?: unknown };
    if (typeof shaped.id !== 'string' || typeof shaped.alg !== 'string') {
      throw new CliError(`${path}: key #${String(index + 1)} needs string "id" and "alg"`, 3);
    }
    if (!KEY_STATES.includes(shaped.state as KeyState)) {
      throw new CliError(
        `${path}: key "${shaped.id}" has state "${String(shaped.state)}"`,
        3,
        `expected one of ${KEY_STATES.join(', ')}`,
      );
    }
    return { id: shaped.id, alg: shaped.alg as VaultAlg, state: shaped.state as KeyState };
  });

  return {
    keys: entries,
    ...(rawMaterials === undefined
      ? {}
      : { materials: rawMaterials as Readonly<Record<string, string>> }),
  };
}

/**
 * `tsir vault:key:activate --key <id> [--manifest <path>] [--json]`
 *
 * Prints the promotion plan; never applies it. `--key` is required and must match
 * the staged key, because activating "whatever is staged" is how the wrong key gets
 * promoted on a shared machine.
 */
export async function vaultKeyActivateCommand(argv: readonly string[]): Promise<number> {
  const { flags } = parseArgs(argv, {
    '--key': { type: 'string', description: 'id of the staged key to activate' },
    '--manifest': { type: 'string', description: 'keyring manifest (default: TSIR_KEYRING_FILE)' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const requested = typeof flags['key'] === 'string' ? flags['key'].trim() : '';
  if (requested === '') {
    throw new UsageError(
      'vault:key:activate needs --key <id>',
      'the id is printed by vault:key:generate',
    );
  }

  const now = process.env['APP_KEY_NOW'];
  const next = process.env['APP_KEY_NEXT'];
  const manifestPath =
    typeof flags['manifest'] === 'string' ? flags['manifest'] : process.env['TSIR_KEYRING_FILE'];

  const deployed = await readManifest(manifestPath);
  const plan = planActivation({
    now: now ?? '',
    next,
    ...(deployed === undefined ? {} : { manifest: deployed.keys }),
    ...(deployed?.materials === undefined ? {} : { materials: deployed.materials }),
    nowIso: new Date().toISOString(),
  });

  if (plan.toKeyId !== requested) {
    throw new UsageError(
      `--key ${requested} does not match the staged key ${plan.toKeyId}`,
      'activate the key that is deployed as APP_KEY_NEXT, or deploy that key first',
    );
  }

  if (flags['json'] === true) {
    info(
      jsonDocument({
        ok: true,
        fromKeyId: plan.fromKeyId,
        toKeyId: plan.toKeyId,
        env: { APP_KEY_NOW: `<material of ${plan.toKeyId}>`, APP_KEY_NEXT: '' },
        manifest: plan.manifest,
        changes: plan.changes,
        applied: false,
      }),
    );
    return EXIT.ok;
  }

  ok(`activation plan: ${style.bold(plan.fromKeyId)} → ${style.bold(plan.toKeyId)}`);
  info('');
  for (const change of plan.changes) info(`  ${change}`);
  info('');
  info(style.bold('env (apply to every instance):'));
  // The value is the APP_KEY_NEXT the operator already holds — printing it again
  // would put key material in a shell history for no reason.
  info(`  APP_KEY_NOW="\${APP_KEY_NEXT}"   ${style.dim(`(material of ${plan.toKeyId})`)}`);
  info('  APP_KEY_NEXT=');
  info('');
  info(style.bold('manifest (deploy as TSIR_KEYRING_FILE):'));
  info(JSON.stringify({ keys: plan.manifest }, null, 2));
  info('');
  info(
    style.dim(
      'nothing was applied. Deploy the manifest first, then switch APP_KEY_NOW, then run `tsir vault:rotate`.',
    ),
  );
  return EXIT.ok;
}

/**
 * The vault the application is actually running with (`VLT-020`).
 *
 * The CLI does not build one from `APP_KEY_*`. Rotation must re-encrypt with the
 * *same keyring the app writes with* — a CLI that re-derived keys from a partly
 * correct environment would happily "rotate" rows onto a key the app cannot read,
 * and the mistake would surface as `VLT_UNKNOWN_KEY` in production rather than as a
 * message here. So the entry exports it, exactly like `database` (ADR-0009).
 */
export async function resolveVault(project: LoadedProject): Promise<Vault> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly vault?: unknown;
  };
  const candidate = module.vault as Partial<Vault> | undefined;
  const looksRight =
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.encrypt === 'function' &&
    typeof candidate.decrypt === 'function' &&
    typeof candidate.activeKeyId === 'string';

  if (!looksRight) {
    throw new CliError(
      `no vault found in ${project.entryPath}`,
      EXIT.environment,
      'export the Vault your app already uses: `export const vault = await createVault({ keyring })`',
    );
  }
  return candidate as Vault;
}

/** `EXIT.failure` means "ran, but did not finish cleanly" — a lock is not that. */
const EXIT_LOCKED = 4;

/**
 * `tsir vault:rotate --table <table> --column <column> [--key-column id]`
 *
 * One target per invocation on purpose: re-encrypting a column is a perimeter
 * operation, and a command that silently does four of them because a config file
 * listed four is a command whose blast radius the operator did not choose.
 */
export async function vaultRotateCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--table': { type: 'string', description: 'table holding the encrypted column' },
    '--column': { type: 'string', description: 'the encrypted column to re-encrypt' },
    '--key-column': { type: 'string', description: 'primary key column', default: 'id' },
    '--batch': { type: 'string', description: 'rows per round trip', default: '500' },
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--dry-run': { type: 'boolean', description: 'report what is left; write nothing' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const target = targetFromFlags(args.flags);
  const batchSize = batchSizeFromFlags(args.flags);
  const json = boolFlag(args, '--json');

  const project = await loadProject(process.cwd());
  const vault = await resolveVault(project);
  const { database } = await bindDatabase(project, stringFlag(args, '--connection'));
  const store = createRotationStore(database, target);

  if (boolFlag(args, '--dry-run')) {
    const status = await rotationStatus({
      store,
      targets: [target],
      activeKeyId: vault.activeKeyId,
    });
    if (json) {
      info(jsonDocument({ ok: true, dryRun: true, ...status }));
      return EXIT.ok;
    }
    info(
      `${style.bold(target.table)}.${target.column} on key ${style.bold(vault.activeKeyId)}: ` +
        `${String(status.remaining)} row(s) left`,
    );
    info(style.dim('dry run: nothing was written'));
    return EXIT.ok;
  }

  if (!json) {
    info(
      `rotating ${style.bold(`${target.table}.${target.column}`)} onto key ` +
        `${style.bold(vault.activeKeyId)} ${style.dim(`(batch ${String(batchSize)})`)}`,
    );
  }

  const report = await runRotation({ vault, store, targets: [target], batchSize });
  const progress = report.targets[0];

  if (json) {
    info(
      jsonDocument({
        ok: report.failed === 0 && progress?.locked !== true && progress?.error === undefined,
        activeKeyId: vault.activeKeyId,
        target,
        rotated: report.rotated,
        failed: report.failed,
        remaining: report.remaining,
        elapsedMs: report.elapsedMs,
        rowsPerSecond: Math.round(report.rowsPerSecond * 10) / 10,
        etaMs: report.etaMs === undefined ? null : Math.round(report.etaMs),
        locked: progress?.locked === true,
        aborted: progress?.aborted === true,
        ...(progress?.error === undefined ? {} : { error: progress.error }),
        failures: report.failures,
      }),
    );
    return exitCodeFor(report, progress?.locked === true);
  }

  if (progress?.locked === true) {
    warn(`another rotation holds ${target.table}.${target.column} — nothing was done`);
    info(
      style.dim('wait for it to finish, then run this again; it resumes where the other stopped'),
    );
    return EXIT_LOCKED;
  }

  if (report.rotated > 0) {
    ok(
      `${String(report.rotated)} row(s) re-encrypted · ` +
        `${String(Math.round(report.rowsPerSecond))} rows/s · ${formatMs(report.elapsedMs)}`,
    );
  } else {
    info('nothing to do: every row is already on the active key');
  }
  if (report.remaining > 0) {
    warn(`${String(report.remaining)} row(s) still on an old key — run again to continue`);
  }
  for (const failure of report.failures) {
    warn(`${failure.target} row ${failure.key}: ${failure.code} — ${failure.message}`);
  }
  return exitCodeFor(report, false, progress?.error);
}

/** `tsir vault:rotate:status --table <table> --column <column> [--json]` */
export async function vaultRotateStatusCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--table': { type: 'string', description: 'table holding the encrypted column' },
    '--column': { type: 'string', description: 'the encrypted column to inspect' },
    '--key-column': { type: 'string', description: 'primary key column', default: 'id' },
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const target = targetFromFlags(args.flags);
  const json = boolFlag(args, '--json');

  const project = await loadProject(process.cwd());
  const vault = await resolveVault(project);
  const { database } = await bindDatabase(project, stringFlag(args, '--connection'));

  const status = await rotationStatus({
    store: createRotationStore(database, target),
    targets: [target],
    activeKeyId: vault.activeKeyId,
  });

  if (json) {
    // `undefined` does not survive JSON.stringify: the schema says `null`, so a
    // consumer never has to distinguish "absent" from "unknown".
    const targets = status.targets.map((entry) => ({ ...entry, percent: entry.percent ?? null }));
    info(jsonDocument({ ok: true, ...status, targets }));
    return EXIT.ok;
  }

  const entry = status.targets[0];
  const percent = entry?.percent === undefined ? '—' : `${(entry.percent * 100).toFixed(1)}%`;
  ok(`${target.table}.${target.column}: ${String(status.remaining)} row(s) on another key`);
  info(style.dim(`  active key ${vault.activeKeyId} · ${percent} of rows known to be on it`));
  if (status.remaining > 0) {
    info(style.dim('  `tsir vault:rotate --table … --column …` continues from here'));
  }
  return EXIT.ok;
}

function targetFromFlags(flags: Readonly<Record<string, string | boolean>>): RotationTarget {
  const table = typeof flags['table'] === 'string' ? flags['table'].trim() : '';
  const column = typeof flags['column'] === 'string' ? flags['column'].trim() : '';
  if (table === '' || column === '') {
    throw new UsageError(
      'vault:rotate needs --table <table> --column <column>',
      'the AAD binds both, so both are required; --key-column defaults to id',
    );
  }
  const keyColumn = typeof flags['key-column'] === 'string' ? flags['key-column'].trim() : 'id';
  return { table, column, keyColumn: keyColumn === '' ? 'id' : keyColumn };
}

function batchSizeFromFlags(flags: Readonly<Record<string, string | boolean>>): number {
  // coercion-ok: a flag is the one place a string is meant to be a number.
  const value = Number(typeof flags['batch'] === 'string' ? flags['batch'] : '500');
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new UsageError(
      '--batch must be a whole number between 1 and 10000',
      'larger batches hold the writer lock longer; 500 is the default for a reason',
    );
  }
  return value;
}

function exitCodeFor(report: { readonly failed: number }, locked: boolean, error?: string): number {
  if (locked) return EXIT_LOCKED;
  if (error !== undefined) return EXIT.failure;
  return report.failed === 0 ? EXIT.ok : EXIT.failure;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * `tsir vault:key:retire --key <id> --table <table> --column <column>`
 *
 * The last step of the runbook, and the only one that can lose data: a retired key
 * keeps no material, so every row that still names it becomes unreadable. That is
 * why the target column is mandatory — "how many rows still reference this key" is a
 * question about a column, and a retire that cannot count is a retire that lies
 * (`VLT-017`). `--force` exists for the operator who accepts the loss, and it needs
 * `--confirm <id>` typed out: a flag that is easy to repeat from shell history is
 * not a confirmation.
 */
export async function vaultKeyRetireCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--key': { type: 'string', description: 'id of the key to retire' },
    '--table': { type: 'string', description: 'table holding the encrypted column' },
    '--column': { type: 'string', description: 'the encrypted column to count' },
    '--key-column': { type: 'string', description: 'primary key column', default: 'id' },
    '--connection': { type: 'string', description: 'named connection (MIG-015)' },
    '--manifest': { type: 'string', description: 'keyring manifest (default: TSIR_KEYRING_FILE)' },
    '--force': { type: 'boolean', description: 'retire even though rows still reference the key' },
    '--confirm': { type: 'string', description: 'the key id, typed again to confirm --force' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const keyId = (typeof args.flags['key'] === 'string' ? args.flags['key'] : '').trim();
  if (keyId === '') {
    throw new UsageError(
      'vault:key:retire needs --key <id>',
      'the id is printed by `tsir vault:key:generate`',
    );
  }

  const target = targetFromFlags(args.flags);
  const force = boolFlag(args, '--force');
  const confirm = typeof args.flags['confirm'] === 'string' ? args.flags['confirm'].trim() : '';

  if (force && confirm !== keyId) {
    throw new UsageError(
      '--force needs --confirm <key id> typed out',
      `a retirement that strands rows is not undoable: re-run with --confirm ${keyId} if that is what you want`,
    );
  }

  const manifestPath =
    typeof args.flags['manifest'] === 'string'
      ? args.flags['manifest']
      : process.env['TSIR_KEYRING_FILE'];
  const deployed = await readManifest(manifestPath);
  if (deployed === undefined) {
    throw new CliError(
      'vault:key:retire needs the deployed manifest',
      EXIT.environment,
      'set TSIR_KEYRING_FILE (or --manifest) to the manifest the running instances carry',
    );
  }

  const project = await loadProject(process.cwd());
  const vault = await resolveVault(project);
  const { database } = await bindDatabase(project, stringFlag(args, '--connection'));
  const remaining = await createRotationStore(database, target).countKey(keyId);

  // The writer is the key that encrypts today, which ADR-0021 makes `_NEXT` when it
  // is set — so the vault's own answer is the one to trust, not the env var order.
  const plan = planRetire({
    keyId,
    manifest: deployed.keys,
    ...(deployed.materials === undefined ? {} : { materials: deployed.materials }),
    remaining,
    activeKeyId: vault.activeKeyId,
    force,
    nowIso: new Date().toISOString(),
  });

  if (boolFlag(args, '--json')) {
    info(
      jsonDocument({
        ok: true,
        keyId: plan.keyId,
        fromState: plan.fromState,
        remaining: plan.remaining,
        forced: plan.forced,
        target,
        changes: plan.changes,
        manifest: plan.manifest,
        materials: Object.keys(plan.materials),
        written: false,
      }),
    );
    return EXIT.ok;
  }

  ok(
    `retirement plan: ${style.bold(`${plan.fromState} → retired`)} for key ${style.bold(plan.keyId)}`,
  );
  info('');
  for (const change of plan.changes) info(`  ${change}`);
  info('');
  info(style.bold('manifest (deploy as TSIR_KEYRING_FILE):'));
  info(
    JSON.stringify(
      {
        keys: plan.manifest,
        ...(Object.keys(plan.materials).length === 0 ? {} : { materials: plan.materials }),
      },
      null,
      2,
    ),
  );
  info('');
  if (plan.forced) {
    warn(
      `key ${plan.keyId} keeps no material: ${String(plan.remaining)} row(s) become unreadable (VLT_UNKNOWN_KEY)`,
    );
  }
  info(
    style.dim(
      'nothing was applied. Deploy the manifest to every instance; the key is gone after that.',
    ),
  );
  return EXIT.ok;
}
