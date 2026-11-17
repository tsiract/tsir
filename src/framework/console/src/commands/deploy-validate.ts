/**
 * `tsir deploy:validate` — the release gate (`DPL-019`, `DPL-012`, `DPL-020`).
 *
 * Everything the build already knows is re-checked here against what is **on disk**, because
 * the interesting failures happen between the two: a budget raised after the build, an
 * artifact edited by hand, a secret that arrived in a bundle because someone inlined a
 * value. The gate reads `dist/build.json` instead of re-deriving the build (§ 3.4), so it
 * costs milliseconds and can run in CI on every pull request.
 *
 * It answers exactly four questions:
 *
 *   1. **Is the build the one we think it is?** Every artifact listed in `build.json` exists
 *      and still has the bytes (and gzipped bytes) the build recorded.
 *   2. **Does it fit?** Gzipped size against each target's budget, read from `tsir.js`
 *      *now*, not from the document.
 *   3. **Is anything secret in it?** Every file in the output directory is scanned with the
 *      rules in `@tsir/deploy` (`DPL_SECRET_LEAK`); findings never print the value.
 *   4. **Can the targets run it?** The graph is re-validated against each configured target's
 *      capabilities and bindings, so a module that grew a `raw-sockets` requirement since
 *      the snapshot cannot ship quietly.
 *
 * It does not deploy, and it does not hold credentials: the deploy contract keeps the
 * framework out of `wrangler deploy` and `sam deploy` unless a human opts in.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { DeployTarget } from '@tsir/core';
import {
  checkGraph,
  hasLeak,
  privateExposed,
  scanSources,
  type GraphProblem,
  type SecretFinding,
  type SourceFile,
} from '@tsir/deploy';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, style, UsageError, warn, jsonDocument, symbols } from '../output.ts';
import {
  BUILD_FILE,
  budgetFor,
  isDeployTarget,
  kibibytes,
  resolveBuild,
  type ResolvedBuild,
} from './deploy-build.ts';

/** Files larger than this are not artifacts anybody deploys; scan them and say so. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

export interface ArtifactCheck {
  readonly target: string;
  readonly unit: string;
  readonly file: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly budget: number;
  readonly overBudget: boolean;
  /** Bytes on disk differ from the ones the build recorded. */
  readonly stale: boolean;
  readonly missing: boolean;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly outDir: string;
  readonly targets: readonly string[];
  readonly artifacts: readonly ArtifactCheck[];
  readonly findings: readonly SecretFinding[];
  readonly problems: readonly GraphProblem[];
  readonly warnings: readonly string[];
  /** The build document itself is absent: nothing to validate. */
  readonly missingBuild: boolean;
  /** Secret binding names the graph declares — the names the scan looks for. */
  readonly secretNames: readonly string[];
  readonly scanned: number;
}

interface BuiltArtifact {
  readonly target?: unknown;
  readonly unit?: unknown;
  readonly file?: unknown;
  readonly bytes?: unknown;
  readonly gzipBytes?: unknown;
}

/** Every file under a directory, in a stable order (a report that reshuffles is unreadable). */
async function walk(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: false });
  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** The secret binding names a graph declares, deduplicated and sorted. */
export function secretNamesOf(resolved: ResolvedBuild): readonly string[] {
  const names = new Set<string>();
  for (const unit of resolved.graph.units) {
    for (const binding of unit.bindings) {
      if (binding.kind === 'secret') names.add(binding.name);
    }
  }
  return [...names].sort();
}

/**
 * Does the artifact agree with the graph about who can reach the unit? (`DPL-022`)
 *
 * Only the dangerous direction is a problem: a **private** unit whose config is publicly
 * routable. The reverse — a public unit someone disabled — is a warning, because it cannot
 * leak anything; it just means the artifacts and `tsir.js` disagree.
 *
 * The check reads the emitted files rather than the options that produced them: the whole
 * point is what is on disk after a hand edit or a half-finished rebuild.
 */
export function exposureProblems(
  resolved: ResolvedBuild,
  sources: readonly SourceFile[],
): { readonly problems: readonly GraphProblem[]; readonly warnings: readonly string[] } {
  const problems: GraphProblem[] = [];
  const warnings: string[] = [];
  const byFile = new Map(sources.map((source) => [source.file, source.contents]));

  for (const unit of resolved.graph.units) {
    const toml = byFile.get(`cloudflare/${unit.name}/wrangler.${unit.name}.toml`);
    if (toml !== undefined) {
      const disabled = /^workers_dev\s*=\s*false$/mu.test(toml);
      if (unit.private && !disabled) {
        const error = privateExposed({
          unit: unit.name,
          target: 'cloudflare',
          detail: 'has no `workers_dev = false`, so `wrangler deploy` would give it a public URL',
        });
        problems.push({
          unit: unit.name,
          code: error.code,
          message: error.message,
          hint: error.hint ?? '',
        });
      }
      if (!unit.private && disabled) {
        warnings.push(
          `${unit.name}: the cloudflare artifact disables workers.dev but the unit is public in tsir.js`,
        );
      }
    }

    const template = byFile.get(`lambda/${unit.name}/template.${unit.name}.yaml`);
    if (template !== undefined && unit.private && /^\s+Type: HttpApi$/mu.test(template)) {
      const error = privateExposed({
        unit: unit.name,
        target: 'lambda',
        detail: 'routes through an API Gateway HTTP API, which is a public endpoint',
      });
      problems.push({
        unit: unit.name,
        code: error.code,
        message: error.message,
        hint: error.hint ?? '',
      });
    }
  }

  return { problems, warnings };
}

export interface ValidateOptions {
  readonly outDir?: string | undefined;
}

/**
 * Check a build directory. Pure with respect to the project: it reads, it never writes.
 *
 * A missing `build.json` is a **report**, not a thrown error, so the CLI can print the one
 * instruction that fixes it (`tsir deploy:build`) instead of a path and a stack.
 */
export async function validate(
  cwd: string,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const resolved = await resolveBuild(cwd, options);
  const buildPath = join(resolved.outDir, BUILD_FILE);
  const secretNames = secretNamesOf(resolved);

  if (!existsSync(buildPath)) {
    return {
      ok: false,
      outDir: resolved.outDirName,
      targets: resolved.targets,
      artifacts: [],
      findings: [],
      problems: [],
      warnings: [],
      missingBuild: true,
      secretNames,
      scanned: 0,
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(await readFile(buildPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    throw new UsageError(
      `${join(resolved.outDirName, BUILD_FILE)} is not readable JSON — rebuild it with \`tsir deploy:build\``,
      error instanceof Error ? error.message : String(error),
    );
  }

  const listed = (document as { artifacts?: unknown }).artifacts;
  const entries: readonly BuiltArtifact[] = Array.isArray(listed)
    ? (listed as BuiltArtifact[])
    : [];

  // Which targets to validate comes from the **build document**, not from `tsir.js`: the
  // question is whether *this* build is deployable, and `--target cloudflare` on a project
  // that also configures Lambda answers for Cloudflare alone.
  const recorded = (document as { targets?: unknown }).targets;
  const targets: readonly DeployTarget[] = Array.isArray(recorded)
    ? recorded.filter(
        (target): target is DeployTarget => typeof target === 'string' && isDeployTarget(target),
      )
    : resolved.targets;

  const artifacts: ArtifactCheck[] = [];
  for (const entry of entries) {
    const file = typeof entry.file === 'string' ? entry.file : '';
    const path = join(resolved.outDir, file);
    const budget = budgetFor(entry.target as never, resolved.configured);
    const missing = file === '' || !existsSync(path);
    const size = missing ? undefined : gzipSync(await readFile(path), { level: 9 }).byteLength;
    const bytes = missing ? 0 : (await readFile(path)).byteLength;

    artifacts.push({
      target: typeof entry.target === 'string' ? entry.target : '?',
      unit: typeof entry.unit === 'string' ? entry.unit : '?',
      file,
      bytes,
      gzipBytes: size ?? 0,
      budget,
      overBudget: size !== undefined && size > budget,
      // A build document that no longer describes the file is exactly the drift this
      // command exists to catch: `--allow-size-regression` and hand edits both look like it.
      stale:
        size !== undefined &&
        (entry.gzipBytes !== size || (typeof entry.bytes === 'number' && entry.bytes !== bytes)),
      missing,
    });
  }

  const warnings: string[] = [];
  const sources: SourceFile[] = [];
  for (const path of await walk(resolved.outDir)) {
    const contents = await readFile(path);
    if (contents.byteLength > MAX_SCAN_BYTES) {
      warnings.push(
        `${relative(resolved.outDir, path)} is ${kibibytes(contents.byteLength)} — too large to scan, excluded`,
      );
      continue;
    }
    sources.push({ file: relative(resolved.outDir, path), contents: contents.toString('utf8') });
  }

  const findings = scanSources(sources, secretNames);
  const exposure = exposureProblems(resolved, sources);
  // The targets *being deployed*, not just the ones with a config block: a project that
  // builds for Cloudflare without declaring its bindings must hear about that here, since
  // `deploy:build` only checks the targets `tsir.js` describes.
  const checked = targets.map(
    (target) => resolved.configured.find((entry) => entry.target === target) ?? { target },
  );
  const problems = checkGraph(resolved.graph, { targets: checked })
    .filter((problem) => problem.code !== 'DPL_UNIT_EMPTY')
    .concat(exposure.problems);

  warnings.push(...exposure.warnings);
  const ok =
    findings.length === 0 &&
    problems.length === 0 &&
    artifacts.every((artifact) => !artifact.overBudget && !artifact.stale && !artifact.missing);

  return {
    ok,
    outDir: resolved.outDirName,
    targets,
    artifacts,
    findings,
    problems,
    warnings,
    missingBuild: false,
    secretNames,
    scanned: sources.length,
  };
}

/** The human report. Every line is safe to paste into an issue or a build log. */
export function formatValidation(report: ValidationReport): string {
  if (report.missingBuild) {
    return `  ${style.red(symbols.cross)} no ${BUILD_FILE} in ${report.outDir}/ — run \`tsir deploy:build\` first\n`;
  }

  const lines: string[] = [];
  const over = report.artifacts.filter((artifact) => artifact.overBudget);
  const stale = report.artifacts.filter((artifact) => artifact.stale);
  const missing = report.artifacts.filter((artifact) => artifact.missing);
  const totalGzip = report.artifacts.reduce((sum, artifact) => sum + artifact.gzipBytes, 0);

  lines.push(
    `  ${style.green(symbols.check)} ${String(report.artifacts.length)} artifact(s), ${kibibytes(totalGzip)} gzipped in total`,
  );
  for (const artifact of stale) {
    lines.push(
      `  ${style.red(symbols.cross)} ${artifact.file} changed since the build — rebuild it (recorded size does not match the file)`,
    );
  }
  for (const artifact of missing) {
    lines.push(
      `  ${style.red(symbols.cross)} ${artifact.file} is listed in ${BUILD_FILE} but missing from disk`,
    );
  }
  for (const artifact of over) {
    lines.push(
      `  ${style.red(symbols.cross)} DPL_SIZE_BUDGET · ${artifact.file} is ${kibibytes(artifact.gzipBytes)} gzipped, budget ${kibibytes(artifact.budget)}`,
    );
  }

  if (hasLeak(report.findings)) {
    lines.push(
      `  ${style.red(symbols.cross)} DPL_SECRET_LEAK · ${String(report.findings.length)} finding(s) in ${String(report.scanned)} file(s):`,
    );
    for (const finding of report.findings) {
      // The line, the pattern's name and a redacted excerpt — never the value itself, which
      // is the whole reason this output is safe to put in a CI log.
      lines.push(`    ${finding.file}:${String(finding.line)} matches ${finding.pattern}`);
      lines.push(`    ${style.dim(finding.excerpt)}`);
    }
  } else {
    lines.push(
      `  ${style.green(symbols.check)} no secret values in ${String(report.scanned)} file(s)` +
        (report.secretNames.length === 0 ? '' : ` (looking for ${report.secretNames.join(', ')})`),
    );
  }

  for (const problem of report.problems) {
    lines.push(`  ${style.red(symbols.cross)} ${problem.code} · ${problem.message}`);
    lines.push(`    ${problem.hint}`);
  }

  if (report.problems.length === 0) {
    lines.push(
      `  ${style.green(symbols.check)} graph valid for ${report.targets.join(', ')} (capabilities and bindings)`,
    );
  }

  return `${lines.join('\n')}\n`;
}

export async function deployValidateCommand(argv: readonly string[]): Promise<number> {
  return deployValidate(argv, process.cwd());
}

/**
 * `deploy:validate [--out dist] [--json]`.
 *
 * Exit codes: `0` clean, `1` a finding (leak, stale artifact, over budget, invalid graph),
 * `2` usage — the same contract as the other deploy commands.
 */
export async function deployValidate(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseArgs(argv, {
    '--out': { type: 'string', description: 'build directory to validate (default dist)' },
    '--json': { type: 'boolean', description: 'machine-readable report' },
  });
  const json = boolFlag(args, '--json');
  const outFlag = stringFlag(args, '--out');

  let report: ValidationReport;
  try {
    report = await validate(cwd, { ...(outFlag === undefined ? {} : { outDir: outFlag }) });
  } catch (error: unknown) {
    return fail(error, json);
  }

  for (const warning of report.warnings) warn(warning);

  if (json) {
    info(
      jsonDocument({
        ok: report.ok,
        outDir: report.outDir,
        targets: report.targets,
        artifacts: report.artifacts.map((artifact) => ({
          target: artifact.target,
          unit: artifact.unit,
          file: artifact.file,
          bytes: artifact.bytes,
          gzipBytes: artifact.gzipBytes,
          budget: Number.isFinite(artifact.budget) ? artifact.budget : null,
          overBudget: artifact.overBudget,
          stale: artifact.stale,
          missing: artifact.missing,
        })),
        secretNames: report.secretNames,
        scanned: report.scanned,
        findings: report.findings,
        problems: report.problems,
        warnings: report.warnings,
      }),
    );
    return report.ok ? EXIT.ok : EXIT.failure;
  }

  info(formatValidation(report));
  return report.ok ? EXIT.ok : EXIT.failure;
}
