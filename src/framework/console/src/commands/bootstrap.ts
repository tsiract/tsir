/**
 * `tsir bootstrap` — the deploy block (`DPL-023`, `CFG-120`).
 *
 * The command does three things, in this order, and the order is the contract:
 *
 *   1. **Detect.** Read what the project already is: a `wrangler.toml` (or a `wrangler` dependency)
 *      means Cloudflare, a `template.yaml`, `cdk.json` or `aws-cdk-lib` dependency means Lambda, a
 *      `Dockerfile` or `fly.toml` means the Bun target, and `.env.example` names a provider. Nothing is inferred from a file that is not there, and nothing is invented.
 *   2. **Plan.** Render the `managed:deploy` region and print the diff. `--plan` stops here;
 *      so does a run without `--yes`, because a command that edits `tsir.js` should be asked
 *      once more than it is run.
 *   3. **Apply.** Rewrite only the fenced region, atomically (temp file + rename), and print
 *      what it touched.
 *
 * What it will not do:
 *
 *   · **Touch a line outside the fence.** The region is the whole permission slip
 *   · **Overwrite a hand-written `deploy` key.** If `tsir.js` already declares `deploy`
 *     outside a managed region, the plan says so and stops: two owners of the deploy shape is
 *     exactly the drift ADR-0026 exists to prevent.
 *   · **Write the boot manifest.** `.tsir/manifest.json` belongs to `tsir build` and holds
 *     the production manifest; bootstrap writing a second shape into it would break boot.
 */

import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  applyManagedRegion,
  formatDiff,
  hasManagedRegion,
  inlinedSecretsInText,
  managedRegions,
} from '@tsir/config';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { CliError, EXIT, fail, info, style, UsageError, jsonDocument, symbols } from '../output.ts';
import {
  BOOTSTRAP_RECORD,
  readBootstrapRecord,
  readPresetRecords,
  renderBootstrapRecord,
} from '../bootstrap-record.ts';
import { findConfigFile } from '../project.ts';
import { migrateConfig } from './migrate-config.ts';
import { createInterface } from 'node:readline/promises';

import { RACT_MODE, RACT_TEMPLATE } from './project-command.ts';
import { parseSetOverrides, takeRepeated } from './bootstrap-set.ts';

/** The region `bootstrap` owns. One id, so `--plan` can never be ambiguous. */
export const DEPLOY_REGION = 'deploy';

export type BootstrapTarget = 'bun' | 'cloudflare' | 'lambda';

/** Files that mean a target is already part of this project. */
const DETECTORS: readonly {
  readonly file: string;
  readonly target: BootstrapTarget;
  readonly why: string;
}[] = [
  { file: 'wrangler.toml', target: 'cloudflare', why: 'wrangler.toml' },
  { file: 'wrangler.jsonc', target: 'cloudflare', why: 'wrangler.jsonc' },
  { file: 'template.yaml', target: 'lambda', why: 'template.yaml' },
  { file: 'template.yml', target: 'lambda', why: 'template.yml' },
  { file: 'cdk.json', target: 'lambda', why: 'cdk.json' },
  { file: 'Dockerfile', target: 'bun', why: 'Dockerfile' },
  { file: 'fly.toml', target: 'bun', why: 'fly.toml' },
];

export interface Detection {
  readonly target: BootstrapTarget;
  /** The file that made it true, so the plan can say *why* rather than just *what*. */
  readonly why: readonly string[];
}

/** Packages in `package.json` that mean a target is already part of this project (CFG-109). */
const DEPENDENCY_SIGNALS: readonly {
  readonly name: string;
  readonly target: BootstrapTarget;
}[] = [
  { name: 'wrangler', target: 'cloudflare' },
  { name: 'aws-cdk-lib', target: 'lambda' },
  { name: 'aws-cdk', target: 'lambda' },
];

/**
 * Variables in `.env.example` that name a provider account (CFG-109). AWS variables are left out on
 * purpose: S3-compatible storage reads the same names, so they would suggest Lambda where there is
 * only a bucket.
 */
const ENV_SIGNALS: readonly {
  readonly name: string;
  readonly target: BootstrapTarget;
}[] = [
  { name: 'CLOUDFLARE_ACCOUNT_ID', target: 'cloudflare' },
  { name: 'CLOUDFLARE_API_TOKEN', target: 'cloudflare' },
];

/** Dependency names declared in `package.json`. A malformed file declares nothing. */
function declaredDependencies(root: string): ReadonlySet<string> {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const names = [parsed['dependencies'], parsed['devDependencies']].flatMap((block) =>
      block !== null && typeof block === 'object' ? Object.keys(block) : [],
    );
    return new Set(names);
  } catch {
    return new Set();
  }
}

/** Variable names assigned in `.env.example`, comments and blank lines skipped. */
function declaredEnvNames(root: string): ReadonlySet<string> {
  const path = join(root, '.env.example');
  if (!existsSync(path)) return new Set();
  const names = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  return new Set(names);
}

/**
 * Which targets this project already deploys to, in a stable order. The signals are the marker
 * files (DPL-023), then the dependencies in `package.json`, then the variables in `.env.example`.
 */
export function detectTargets(root: string): readonly Detection[] {
  const found = new Map<BootstrapTarget, string[]>();
  const note = (target: BootstrapTarget, why: string): void => {
    found.set(target, [...(found.get(target) ?? []), why]);
  };
  for (const detector of DETECTORS) {
    if (existsSync(join(root, detector.file))) note(detector.target, detector.why);
  }
  const dependencies = declaredDependencies(root);
  for (const signal of DEPENDENCY_SIGNALS) {
    if (dependencies.has(signal.name)) note(signal.target, `package.json (${signal.name})`);
  }
  const envNames = declaredEnvNames(root);
  for (const signal of ENV_SIGNALS) {
    if (envNames.has(signal.name)) note(signal.target, `.env.example (${signal.name})`);
  }
  const order: readonly BootstrapTarget[] = ['bun', 'cloudflare', 'lambda'];
  return order
    .filter((target) => found.has(target))
    .map((target) => ({ target, why: found.get(target) ?? [] }));
}

export interface PlanInput {
  readonly topology: 'separate' | 'single';
  readonly targets: readonly BootstrapTarget[];
  /** Set when the user named targets: then detection is a suggestion, not the source. */
  readonly explicit: boolean;
  /** `deploy.includeModules`, from `--set modules+=`. Rendered only when non-empty. */
  readonly includeModules?: readonly string[];
}

export interface BootstrapPlan {
  readonly configPath: string;
  readonly root: string;
  /** The whole file after the change. */
  readonly after: string;
  /** The diff, `-`/`+` blocks. */
  readonly diff: string;
  /** True when the file already says exactly this. */
  readonly unchanged: boolean;
  readonly created: boolean;
  readonly detections: readonly Detection[];
  readonly topology: 'separate' | 'single';
  readonly targets: readonly BootstrapTarget[];
  readonly includeModules: readonly string[];
  /** Keys in the managed region that bootstrap does not write (CFG-112). */
  readonly unused: readonly string[];
}

/** The `deploy` property, rendered as the lines inside the fence. */
export function deployBlockLines(input: PlanInput): readonly string[] {
  // Relative lines: the region's own indent is added by `renderRegion`, so nothing here
  // carries the file's indentation and the block renders the same at any depth.
  const targets = input.targets.map((target) =>
    target === 'cloudflare' ? '    cloudflare: { bindings: {} },' : `    ${target}: {},`,
  );

  return [
    'deploy: {',
    `  topology: '${input.topology}',`,
    ...(input.includeModules === undefined || input.includeModules.length === 0
      ? []
      : [`  includeModules: [${input.includeModules.map((name) => `'${name}'`).join(', ')}],`]),
    ...(targets.length === 0 ? [] : ['  targets: {', ...targets, '  },']),
    '},',
  ];
}

/** Does `tsir.js` already declare `deploy` somewhere the fence does not own? */
/** The keys bootstrap writes inside `managed:deploy`. Anything else there is a leftover (CFG-112). */
const GENERATED_DEPLOY_KEYS: readonly string[] = ['topology', 'includeModules', 'targets'];

/**
 * The keys inside the managed `deploy` region that bootstrap does not write (`CFG-112`). A rewrite
 * replaces the whole region, so these would be lost: they are reported, and an apply refuses.
 */
export function unusedDeployKeys(source: string): readonly string[] {
  const lines = source.split('\n');
  const keys: string[] = [];
  for (const region of managedRegions(source)) {
    if (region.id !== DEPLOY_REGION) continue;
    for (const line of lines.slice(region.start + 1, region.end)) {
      const match = /^ {4}([A-Za-z_]\w*)\s*:/u.exec(line);
      const key = match?.[1];
      if (key !== undefined && !GENERATED_DEPLOY_KEYS.includes(key) && !keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

export function unmanagedDeploy(source: string): boolean {
  const regions = managedRegions(source);
  const owned = regions
    .filter((region) => region.id === DEPLOY_REGION)
    .flatMap((region) => source.split('\n').slice(region.start, region.end + 1));

  const lines = source.split('\n');
  const insideOwned = (index: number): boolean =>
    regions.some(
      (region) => region.id === DEPLOY_REGION && index >= region.start && index <= region.end,
    );

  return lines.some(
    (line, index) => !insideOwned(index) && /^\s*deploy\s*:/u.test(line) && !owned.includes(line),
  );
}

/**
 * Work out what the file would become.
 *
 * Everything that can refuse, refuses here — before a single byte is written.
 */
export async function planBootstrap(
  cwd: string,
  options: {
    readonly topology?: string;
    readonly targets?: readonly string[];
    readonly region?: string;
    readonly includeModules?: readonly string[];
  } = {},
): Promise<BootstrapPlan> {
  const configPath = findConfigFile(cwd);
  const root = configPath.slice(0, configPath.lastIndexOf('/')) || '.';
  const source = await readFile(configPath, 'utf8');

  const topology = options.topology ?? 'separate';
  if (topology !== 'separate' && topology !== 'single') {
    throw new UsageError(`--topology must be "separate" or "single" (got "${topology}")`);
  }

  const detections = detectTargets(root);
  const explicit = options.targets !== undefined && options.targets.length > 0;
  const includeModules = [...(options.includeModules ?? [])];
  // Validate the raw strings *before* they become `BootstrapTarget`: a cast that happens
  // first makes this check unreachable, and an unreachable check is a lie in the source.
  const requested = options.targets ?? [];
  for (const target of requested) {
    if (target !== 'bun' && target !== 'cloudflare' && target !== 'lambda') {
      throw new UsageError(`unknown target "${target}"`, 'expected one of bun, cloudflare, lambda');
    }
  }

  const targets: readonly BootstrapTarget[] = explicit
    ? (requested as readonly BootstrapTarget[])
    : detections.length === 0
      ? // A project with no cloud marker still deploys somewhere: the Bun target needs no
        // extra file, so it is the honest default rather than an empty `targets: {}`.
        ['bun']
      : detections.map((detection) => detection.target);

  if (unmanagedDeploy(source)) {
    throw new UsageError(
      'tsir.js already declares `deploy` outside the managed region',
      'delete that block (or move it inside `// ── managed:deploy:start`) so bootstrap owns exactly one copy',
    );
  }

  const created = !hasManagedRegion(source, DEPLOY_REGION);
  const after = applyManagedRegion(
    source,
    DEPLOY_REGION,
    deployBlockLines({ topology, targets, explicit, includeModules }),
  );
  // CFG-114: a plan that would leave a secret literal in tsir.js is refused before anything is written.
  const leaks = inlinedSecretsInText(after);
  if (leaks.length > 0) {
    throw new CliError(
      `tsir.js would hold a secret literal, which must not be committed: ${leaks.map((leak) => `${leak.where} (${leak.kind})`).join(', ')}`,
      3,
      'move each value to the environment and read it with { fromEnv: "NAME" }, then re-run',
      'CFG_SECRET_INLINED',
    );
  }

  return {
    configPath,
    root,
    after,
    diff: formatDiff(source, after),
    unchanged: after === source,
    created,
    detections,
    topology,
    targets,
    includeModules,
    unused: unusedDeployKeys(source),
  };
}

/** What `tsir doctor --fix` did (`CFG-119`). */
export type RepairResult =
  | { readonly kind: 'no-record' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'repaired'; readonly config: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly hint: string };

const TARGETS: readonly BootstrapTarget[] = ['bun', 'cloudflare', 'lambda'];

/** The `includeModules` a managed region currently declares, read back so a repair keeps them. */
function includeModulesInRegion(source: string): readonly string[] {
  const lines = source.split('\n');
  for (const region of managedRegions(source)) {
    if (region.id !== DEPLOY_REGION) continue;
    for (const line of lines.slice(region.start + 1, region.end)) {
      const match = /^ {4}includeModules: \[(.*)\],?$/u.exec(line);
      if (match?.[1] !== undefined) {
        return [...match[1].matchAll(/'([^']*)'/gu)].map((name) => name[1] ?? '');
      }
    }
  }
  return [];
}

/**
 * `tsir doctor --fix` (`CFG-119`): restores the managed `deploy` region to what `.tsir/bootstrap.json`
 * records. It writes only inside the region. It refuses, and writes nothing, when the record is
 * unreadable, the region is missing, `deploy` is also declared outside the region, or the region holds
 * keys bootstrap does not write.
 */
export async function repairDeployRegion(cwd: string): Promise<RepairResult> {
  const configPath = findConfigFile(cwd);
  const root = configPath.slice(0, configPath.lastIndexOf('/')) || '.';
  const read = await readBootstrapRecord(root);
  if (read.kind === 'missing') return { kind: 'no-record' };
  const refused = (reason: string, hint: string): RepairResult => ({
    kind: 'refused',
    reason,
    hint,
  });
  if (read.kind === 'invalid') {
    return refused(
      `${BOOTSTRAP_RECORD} is not valid JSON`,
      'run tsir bootstrap --plan, then --yes',
    );
  }
  const { deploy } = read.record;
  const targets = deploy.targets.filter((target): target is BootstrapTarget =>
    (TARGETS as readonly string[]).includes(target),
  );
  if (
    (deploy.topology !== 'separate' && deploy.topology !== 'single') ||
    targets.length !== deploy.targets.length
  ) {
    return refused(
      `${BOOTSTRAP_RECORD} names a topology or target bootstrap does not know`,
      'run tsir bootstrap --plan',
    );
  }
  const source = await readFile(configPath, 'utf8');
  if (unmanagedDeploy(source)) {
    return refused(
      'deploy is declared outside the managed region',
      'delete that block or move it inside the region: doctor --fix never edits unmanaged text',
    );
  }
  if (!hasManagedRegion(source, DEPLOY_REGION)) {
    return refused('there is no managed:deploy region', 'run tsir bootstrap --yes to create it');
  }
  const unused = unusedDeployKeys(source);
  if (unused.length > 0) {
    return refused(
      `managed:${DEPLOY_REGION} holds keys bootstrap does not write: ${unused.join(', ')}`,
      'move them below the managed:deploy:end marker, then re-run',
    );
  }
  const after = applyManagedRegion(
    source,
    DEPLOY_REGION,
    deployBlockLines({
      topology: deploy.topology,
      targets,
      explicit: false,
      includeModules: includeModulesInRegion(source),
    }),
  );
  if (after === source) return { kind: 'unchanged' };
  await writeAtomic(configPath, after);
  return { kind: 'repaired', config: configPath.slice(root.length + 1) };
}

/** Write the file the way `09-tsir-config.md § 4` requires: temp file, then rename. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.bootstrap-${String(process.pid)}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, path);
}

export async function bootstrapCommand(argv: readonly string[]): Promise<number> {
  return bootstrap(argv, process.cwd());
}

/**
 * `bootstrap [--plan] [--yes] [--topology separate|single] [--target a,b] [--json]`.
 *
 * Exit codes: `0` planned or applied (a plan that changes nothing is still `0`), `1` refused,
 * `2` usage — the same contract as the rest of the CLI.
 */
/** What bootstrap needs from a terminal. Injected so the prompts can be tested. */
export interface BootstrapIO {
  readonly isTTY: boolean;
  readonly ask: (question: string) => Promise<string>;
}

/** The real terminal: stdin and stdout are both a TTY, and questions are read line by line. */
export function terminalIO(): BootstrapIO {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (question: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export async function bootstrap(
  argv: readonly string[],
  cwd: string,
  io: BootstrapIO = terminalIO(),
): Promise<number> {
  const repeated = takeRepeated(argv, '--set');
  const overrides = parseSetOverrides(repeated.values);
  const args = parseArgs(repeated.rest, {
    '--plan': { type: 'boolean', description: 'print the diff, change nothing' },
    '--yes': { type: 'boolean', description: 'apply the change (required to write)' },
    '--topology': { type: 'string', description: "'separate' (default) or 'single'" },
    '--target': { type: 'string', description: 'comma-separated targets to declare' },
    '--json': { type: 'boolean', description: 'machine-readable plan' },
    '--migrate-config': {
      type: 'boolean',
      description: 'print the migration to the current project format (writes nothing)',
    },
  });

  const json = boolFlag(args, '--json');
  if (boolFlag(args, '--migrate-config')) {
    if (boolFlag(args, '--yes')) {
      return fail(
        new UsageError(
          '--migrate-config never writes, so --yes does not apply',
          'replace the flat database block by hand, as printed',
        ),
        json,
      );
    }
    try {
      return await migrateConfig(cwd, json);
    } catch (error: unknown) {
      return fail(error, json);
    }
  }
  // Fail fast on a missing project before asking any question: a user who
  // answers the topology prompt and then learns there is no `tsir.js` has
  // wasted a keystroke on an operation that cannot run.
  findConfigFile(cwd);
  // CFG-111: with neither --yes nor --plan, a terminal is asked. No terminal means no guessing.
  const interactive = !json && !boolFlag(args, '--yes') && !boolFlag(args, '--plan');
  if (interactive && !io.isTTY) {
    return fail(
      new UsageError(
        'bootstrap has no terminal to ask on, so it will not guess',
        'pass --yes to apply, or --plan to preview',
      ),
      json,
    );
  }
  const targetFlag = stringFlag(args, '--target');
  const topologyFlag = stringFlag(args, '--topology');
  if (
    topologyFlag !== undefined &&
    overrides.topology !== undefined &&
    topologyFlag !== overrides.topology
  ) {
    throw new UsageError(
      `--topology ${topologyFlag} and --set deploy.topology=${overrides.topology} disagree`,
      'pass the topology once',
    );
  }
  let topology: string | undefined = topologyFlag ?? overrides.topology;
  const targetList =
    targetFlag !== undefined
      ? targetFlag.split(',').map((target) => target.trim())
      : overrides.targets;
  if (targetFlag !== undefined && overrides.targets !== undefined) {
    throw new UsageError(
      '--target and --set deploy.targets both set the targets',
      'pass them once',
    );
  }

  if (interactive && topology === undefined) {
    const answer = (await io.ask('deploy topology: separate or single? [separate] ')).trim();
    if (answer !== '' && answer !== 'separate' && answer !== 'single') {
      return fail(new UsageError(`topology must be separate or single (got "${answer}")`), json);
    }
    topology = answer === '' ? undefined : answer;
  }

  let plan: BootstrapPlan;
  try {
    plan = await planBootstrap(cwd, {
      ...(topology === undefined ? {} : { topology }),
      ...(targetList === undefined ? {} : { targets: targetList }),
      includeModules: overrides.includeModules,
    });
  } catch (error: unknown) {
    return fail(error, json);
  }

  if (plan.unused.length > 0 && (interactive || boolFlag(args, '--yes'))) {
    return fail(
      new UsageError(
        `managed:${DEPLOY_REGION} holds keys bootstrap does not write: ${plan.unused.join(', ')}`,
        'bootstrap rewrites the region and would delete them: move them below the managed:deploy:end marker, or delete them by hand, then re-run',
      ),
      json,
    );
  }
  let apply = boolFlag(args, '--yes') && !boolFlag(args, '--plan');
  if (interactive && !plan.unchanged) {
    info(plan.diff.trimEnd());
    const answer = (
      await io.ask(`apply this change to ${plan.configPath.slice(plan.root.length + 1)}? [y/N] `)
    )
      .trim()
      .toLowerCase();
    apply = answer === 'y' || answer === 'yes';
  }
  if (apply && !plan.unchanged) await writeAtomic(plan.configPath, plan.after);
  // CLI-018: bootstrap generates `ract` when the project has none. Nothing is written without --yes.
  const ractPath = join(plan.root, 'ract');
  const ractCreated = apply && !existsSync(ractPath);
  if (ractCreated) {
    await writeFile(ractPath, RACT_TEMPLATE);
    await chmod(ractPath, RACT_MODE);
  }

  // CFG-105: an applied bootstrap leaves its record behind. Deterministic, so a second run
  // with nothing to change rewrites the same bytes.
  if (apply) {
    await mkdir(join(plan.root, '.tsir'), { recursive: true });
    const presets = await readPresetRecords(plan.configPath);
    await writeAtomic(
      join(plan.root, BOOTSTRAP_RECORD),
      renderBootstrapRecord({
        region: DEPLOY_REGION,
        deployLines: deployBlockLines({
          topology: plan.topology,
          targets: plan.targets,
          explicit: false,
          includeModules: plan.includeModules,
        }),
        topology: plan.topology,
        targets: plan.targets,
        presets,
      }),
    );
  }

  if (json) {
    info(
      jsonDocument({
        ok: true,
        config: plan.configPath,
        region: DEPLOY_REGION,
        created: plan.created,
        unchanged: plan.unchanged,
        applied: apply && !plan.unchanged,
        ract: ractCreated,
        topology: plan.topology,
        targets: plan.targets,
        detections: plan.detections,
        diff: plan.diff,
        unused: plan.unused,
      }),
    );
    return EXIT.ok;
  }

  const name = plan.configPath.slice(plan.root.length + 1);
  if (plan.detections.length === 0) {
    info(`  ${style.dim('·')} no target marker found — declaring the bun target`);
  }
  for (const detection of plan.detections) {
    info(`  ${style.dim('·')} ${detection.target}: ${detection.why.join(', ')}`);
  }
  if (plan.unused.length > 0) {
    info(
      `  ${style.dim('·')} unused in managed:${DEPLOY_REGION}: ${plan.unused.join(', ')} (bootstrap rewrites the region and will not apply while they are there)`,
    );
  }

  if (plan.unchanged) {
    info(`  ${style.green(symbols.check)} ${name} already declares this deploy block`);
    return EXIT.ok;
  }

  info(`  ${style.bold(apply ? `updating ${name}` : `planned change to ${name}`)}`);
  info(plan.diff.trimEnd());

  if (!apply) {
    info(`  ${style.dim('nothing written — re-run with --yes to apply')}`);
    return EXIT.ok;
  }

  info(
    `  ${style.green(symbols.check)} updated ${name} (managed:${DEPLOY_REGION}${plan.created ? ', created' : ''})`,
  );
  if (ractCreated)
    info(`  ${style.green(symbols.check)} created ract (run project commands with bun ract)`);
  for (const step of nextSteps({ targets: plan.targets, ract: ractCreated })) {
    info(`  ${style.dim('next:')} ${step}`);
  }
  return EXIT.ok;
}

/**
 * The commands to run after a bootstrap that wrote the deploy block, in the order a user
 * should run them (CFG-117). Pure, so the order is a snapshot test rather than a comment.
 */
export function nextSteps(input: {
  readonly targets: readonly string[];
  readonly ract: boolean;
}): readonly string[] {
  const steps = ['tsir deploy:plan --explain'];
  const targets = input.targets.length > 0 ? input.targets.join(',') : 'bun';
  steps.push(`tsir deploy:build --target ${targets}`);
  steps.push('tsir deploy:validate');
  if (input.ract) steps.push('bun ract help');
  return steps;
}
