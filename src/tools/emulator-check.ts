/**
 * The AWS Emulator table's own gate: does it still cover everything this repository calls, and do
 * its verdicts still match the emulator's source?
 *
 * Two questions, both about **this repository** rather than about a project using tsir:
 *
 *   1. **Completeness.** `awsSurface` scans our `src/` for every AWS operation we call — SDK
 *      command classes and the one wire call we make by hand — and `coverageProblems` fails when
 *      one has no row in the table. A new AWS call cannot land without saying what the emulator
 *      does with it.
 *   2. **Provenance.** `crossCheck` re-derives each verdict from the emulator's handler files at
 *      the pinned tag, vendored under `console/src/commands/fixtures/aws-emulator/`, so a table
 *      that quietly drifts from its evidence is a red build rather than a stale document.
 *
 * Why these live here instead of in `tsir deploy:verify`: they are questions about the framework's
 * own source. The command ships inside an application's `node_modules` and describes tsir's AWS
 * surface; if it also scanned the *caller's* `src/` and failed on an uncovered call, then using
 * AWS in an application would break `tsir deploy:verify` — which is exactly the confusion between
 * the framework's build gate and an application's CLI. `make emulator-check` runs this; the
 * command prints the table.
 *
 * The fixtures are read from the console package because that is where they are maintained: the
 * table and its evidence have one owner, and this gate is a reader of both.
 *
 *   bun src/tools/emulator-check.ts            # gate (CI, `make emulator-check`)
 *   bun src/tools/emulator-check.ts --json     # the same as data
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  EMULATOR_RELEASE,
  OPERATIONS,
  type Verdict,
} from '../framework/console/src/commands/emulator.ts';

/** `src/tools/emulator-check.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');

/**
 * The vendored handler files the verdicts are checked against, at `EMULATOR_RELEASE`.
 *
 * They live beside the table, in `@tsir/console`, so that the table and the evidence that proves it
 * are one artefact with one owner. They are **not** shipped: `check-dist` forbids a `fixtures`
 * directory in the distribution, and an application has no emulator checkout to re-derive verdicts
 * from.
 *
 * 13 handler files, ~512 kB, CC0 — each keeps its own `SPDX-License-Identifier` line, which
 * `check-license` reads and honours.
 */
const FIXTURE_ROOT = join(
  ROOT,
  'src',
  'framework',
  'console',
  'src',
  'commands',
  'fixtures',
  'aws-emulator',
);

/** This module's own path, and the `ours.path` of every row the probe performs. */
const EMULATOR_SELF = 'src/framework/console/src/commands/emulator.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Reading the emulator's source
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The code lines of `text`, so a comment that names an API path is not read as a call to it.
 *
 * Block comments are tracked across lines: the header of this module mentions
 * `/v2/email/outbound-emails`, and without this the gate counted its own prose as a call site.
 */
export function codeOnly(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (isCodeLine(line)) out.push(line);
  }
  return out.join('\n');
}

/** True when `text` carries a line of code, as opposed to a comment, attribute or blank. */
export function isCodeLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  return !(t.startsWith('//') || t.startsWith('#[') || t.startsWith('/*') || t.startsWith('*'));
}

/**
 * The first line of code in the BODY of the last `fn handle` in a handler file.
 *
 * The signature is skipped by counting braces from the `fn handle(` line to the one that opens
 * the body, because the scaffold writes it across four lines and its continuation lines (`&self,`
 * `input: Self::Input,`) are code by any lexical test. Missing that is not hypothetical: the first
 * version of this function reported `&self,` for every handler and so called a working `Invoke`
 * unimplemented — see the AWS Emulator review of 2026-11-13, finding 1.
 *
 * The line it lands on is what separates the verdicts, because the scaffolder is deterministic
 * about what it leaves: a written handler opens with something that reads or checks the request
 * (`if input.…`, `let region = …`, `let Some(state) = …`); an unwritten one opens with
 * `not_implemented(...)` — sometimes after the `let _ = (&input, ctx);` a Unit-input scaffold keeps
 * — or with `Ok(Self::Output::default())`. `undefined` means no `fn handle` at all.
 */
export function selectorsIn(source: string): string | undefined {
  const lines = source.split('\n');
  let signature = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').includes('fn handle')) signature = index;
  }
  if (signature === -1) return undefined;

  // The line that opens the body: the first one where the signature's brace depth becomes 1.
  let depth = 0;
  let bodyStart = -1;
  for (let index = signature; index < lines.length && bodyStart === -1; index += 1) {
    for (const character of lines[index] ?? '') {
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
    }
    if (depth > 0) bodyStart = index;
  }
  if (bodyStart === -1) return undefined;

  // `fn handle(...) {` puts the first statement on the following line; a body that opens on a
  // `fn handle(` continuation puts it after that line too, because the `{` ends its line.
  for (const line of lines.slice(bodyStart + 1)) {
    if (isCodeLine(line)) return line.trim();
  }
  return undefined;
}

/** A body that succeeds without doing anything. */
const HOLLOW = /^Ok\(\s*(Self::Output::)?default\(\)\s*\)/u;
/** The scaffold's refusal, directly or through the service's wrapper. */
const REFUSAL = /(not_implemented\s*\(|scaffolded::)/u;
/** The `let _ = (&input, ctx);` a Unit-input scaffold places before whatever follows it. */
const UNIT_INPUT = /^let _ ?= ?\(?&input, ?&?ctx\)?;?$/u;

/**
 * The verdict a handler's first code line implies, or `written`/`unknown` when only a reader can
 * judge the rest — a written body whose *refusals* decide the answer, which is the `SendEmail` row.
 */
export function verdictFor(firstCodeLine: string | undefined): Verdict | 'written' | 'unknown' {
  if (firstCodeLine === undefined) return 'absent';
  if (REFUSAL.test(firstCodeLine)) return 'stub';
  if (HOLLOW.test(firstCodeLine)) return 'stub';
  if (UNIT_INPUT.test(firstCodeLine)) return 'unknown';
  return 'written';
}

export interface CrossCheck {
  readonly operation: string;
  readonly claimed: Verdict;
  readonly derived: Verdict | 'written' | 'unknown';
  /** `agrees` — the source says what the row says. `reviewed` — the row needed a reader. */
  readonly outcome: 'agrees' | 'reviewed' | 'disagrees';
  readonly firstCodeLine: string | undefined;
  /** `undefined` when the claimed size matches; otherwise `claimed → actual`. */
  readonly sizeMismatch: string | undefined;
}

/** The rule, stated once: what a row may claim, given what its handler's first code line derives. */
export function agreesWith(claimed: Verdict, derived: Verdict | 'written' | 'unknown'): boolean {
  if (derived === 'unknown') return true;
  if (claimed === 'served' || claimed === 'written-refusal') return derived === 'written';
  if (claimed === 'stub') return derived === 'stub';
  // `absent` is derived from a missing file; a present-but-hollow one is the same fact on the wire.
  return derived === 'absent' || derived === 'stub';
}

/**
 * Re-derive every verdict and every size from a checkout of the emulator at `EMULATOR_RELEASE`.
 *
 * It reads `services/<crate>/src/ops/<handler>` only — not the whole tree — so a shallow checkout
 * of `services/` is enough, which is what a CI job would fetch.
 */
export function crossCheck(root: string = FIXTURE_ROOT): readonly CrossCheck[] {
  return OPERATIONS.map((row) => {
    const dir = join(root, 'services', row.crate, 'src', 'ops');
    const file = row.handler === undefined ? undefined : join(dir, row.handler);
    const present = file !== undefined && existsSync(file);
    const source = present ? readFileSync(file, 'utf8') : undefined;
    const firstCodeLine = source === undefined ? undefined : selectorsIn(source);
    const derived: Verdict | 'written' | 'unknown' =
      source === undefined ? 'absent' : verdictFor(firstCodeLine);
    const actual = present ? statSync(file).size : 0;
    return {
      operation: row.operation,
      claimed: row.verdict,
      derived,
      outcome: agreesWith(row.verdict, derived)
        ? derived === 'written' || derived === 'unknown'
          ? 'reviewed'
          : 'agrees'
        : 'disagrees',
      firstCodeLine,
      sizeMismatch: actual === row.bytes ? undefined : `${String(row.bytes)} → ${String(actual)}`,
    };
  });
}

/**
 * Every AWS operation `src/` calls, found two ways because our call sites use two shapes:
 *
 *   · **the SDK** — a command class such as `new PublishCommand(…)`. The class name carries NO
 *     service prefix (`PublishCommand`, not `SNSPublishCommand`), so the service comes from the
 *     import statement the command is destructured from, and otherwise from the single client the
 *     file imports. A file that imports two clients and names a command on neither's line is
 *     reported `ambiguous` rather than attributed by guesswork — the first version of this scan
 *     assumed a prefix, matched nothing at all, and reported the repository as calling only SES.
 *   · **the wire** — a service we call by hand. `src/framework/mail/src/transports/ses.ts` posts
 *     SES v2's `/v2/email/outbound-emails` itself, so there is no SDK import to find and the
 *     operation is only visible in the path it posts to.
 *
 * Scanning is textual on purpose: a scan that needed the type checker would only run when
 * `make check` runs, and this has to answer "what would the emulator have to serve" in a checkout
 * that cannot install its dependencies. This file is skipped: it names client modules and the SES
 * path to describe them, and it calls none of them.
 */
export function awsSurface(
  files: readonly { readonly path: string; readonly text: string }[],
): readonly SurfaceFinding[] {
  const found: SurfaceFinding[] = [];
  const add = (path: string, operation: string, ambiguous = false): void => {
    if (!found.some((entry) => entry.path === path && entry.operation === operation)) {
      found.push({ path, operation, ...(ambiguous ? { ambiguous: true } : {}) });
    }
  };

  for (const file of files) {
    if (
      file.path.endsWith(EMULATOR_SELF) ||
      file.path.endsWith('.d.ts') ||
      file.path.endsWith('.test.ts')
    ) {
      continue;
    }

    const code = codeOnly(file.text);
    /**
     * Which service a command class belongs to.
     *
     * Read from the file's **whole** text, comments included, and that is not laxness: the SQS
     * driver takes its command classes as a parameter and names `@aws-sdk/client-sqs` in the doc
     * comment that says so, because the SDK is app-supplied (ADR-0027 § 1) and the package must
     * not depend on it. Reading code only would lose the one attribution that file has.
     *
     * The cost is that a comment naming a package makes that service a *candidate* for the file,
     * which is why the finding carries `ambiguous` instead of picking one.
     */
    const crates = observedCrates(file.text);
    /** Commands whose service an import statement (or the comment that stands in for one) names. */
    const attributed = new Map<string, string>();
    for (const line of file.text.split('\n')) {
      const onThisLine = SDK_PACKAGES.filter((entry) => entry.pattern.test(line));
      if (onThisLine.length !== 1) continue;
      const crate = onThisLine[0]?.crate;
      if (crate === undefined) continue;
      for (const match of line.matchAll(/\b([A-Z]\w+)Command\b/gu)) {
        const operation = match[1];
        if (operation !== undefined) attributed.set(`${operation}${COMMAND_SUFFIX}`, crate);
      }
    }

    for (const match of code.matchAll(/\b([A-Z]\w+)Command\b/gu)) {
      // The capture is already the operation: the literal `Command` after it is the suffix.
      const operation = match[1];
      if (operation === undefined || operation === COMMAND_SUFFIX) continue;
      const name = `${operation}${COMMAND_SUFFIX}`;
      const exact = attributed.get(name);
      if (exact !== undefined) {
        add(file.path, `${exact}:${operation}`);
        continue;
      }
      if (crates.length === 1) {
        const only = crates[0];
        if (only !== undefined) add(file.path, `${only.crate}:${operation}`);
        continue;
      }
      for (const crate of crates) add(file.path, `${crate.crate}:${operation}`, true);
    }

    // The one hand-written AWS call: SES v2 SendEmail at /v2/email/outbound-emails. Matched in
    // code only — this file's own comment names the path, and a scan that counted comments would
    // report its own documentation as a call site (it did, on the first run of this gate).
    if (/email\/outbound-emails/u.test(code)) {
      add(file.path, 'service-com-amazonaws-sesv2-simpleemailservice-v2:SendEmail');
    }
  }
  return found;
}

/**
 * Every called operation has a row in [`OPERATIONS`]. Sorted, so the message is stable.
 *
 * An `ambiguous` finding is one call whose service the scan could not name; it is covered when
 * any of its candidate services has the row, and reported with its candidates when none does.
 */
export function coverageProblems(surface: readonly SurfaceFinding[]): readonly string[] {
  const rows = new Set(OPERATIONS.map((row) => `${row.crate}:${row.operation}`));
  const missing = new Map<string, Set<string>>();
  const ambiguous = new Map<string, SurfaceFinding[]>();

  for (const call of surface) {
    if (call.ambiguous === true) {
      const operation = call.operation.slice(call.operation.indexOf(':') + 1);
      const group = ambiguous.get(`${call.path}#${operation}`) ?? [];
      group.push(call);
      ambiguous.set(`${call.path}#${operation}`, group);
      continue;
    }
    if (!rows.has(call.operation)) missing.set(call.operation, new Set([call.path]));
  }

  for (const group of ambiguous.values()) {
    if (group.some((entry) => rows.has(entry.operation))) continue;
    const first = group[0];
    if (first === undefined) continue;
    const operation = first.operation.slice(first.operation.indexOf(':') + 1);
    const candidates = group.map((entry) => entry.operation.slice(0, entry.operation.indexOf(':')));
    missing.set(`${operation} (could be ${candidates.join(' or ')})`, new Set([first.path]));
  }

  return [...missing.entries()]
    .map(([operation, paths]) => `${operation} (called from ${[...paths].join(', ')})`)
    .sort();
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. What our own source calls
 * ──────────────────────────────────────────────────────────────────────────── */

/** The SDK client modules, the crate their operations live in, and the command prefix they use. */
const SDK_PACKAGES: readonly {
  readonly pattern: RegExp;
  readonly crate: string;
  readonly prefix: string;
}[] = [
  {
    pattern: /@aws-sdk\/client-sqs\b/u,
    crate: 'service-com-amazonaws-sqs-amazonsqs',
    prefix: 'SQS',
  },
  {
    pattern: /@aws-sdk\/client-sesv2\b/u,
    crate: 'service-com-amazonaws-sesv2-simpleemailservice-v2',
    prefix: 'SESv2',
  },
  {
    pattern: /@aws-sdk\/client-ses\b/u,
    crate: 'service-com-amazonaws-ses-simpleemailservice',
    prefix: 'SES',
  },
  {
    pattern: /@aws-sdk\/client-sns\b/u,
    crate: 'service-com-amazonaws-sns-amazonsimplenotificationservice',
    prefix: 'SNS',
  },
  {
    pattern: /@aws-sdk\/client-lambda\b/u,
    crate: 'service-com-amazonaws-lambda-awsgirapiservice',
    prefix: 'Lambda',
  },
];

/** The command-class suffix every AWS SDK v3 command carries. */
const COMMAND_SUFFIX = 'Command';

/** The crates whose clients a file imports. Exported because it is the half worth testing alone. */
export function observedCrates(
  text: string,
): readonly { readonly crate: string; readonly prefix: string }[] {
  return SDK_PACKAGES.filter((entry) => entry.pattern.test(text)).map(({ crate, prefix }) => ({
    crate,
    prefix,
  }));
}

export interface SurfaceFinding {
  readonly path: string;
  /** `<crate>:<Operation>` — the emulator-side identity of the call. */
  readonly operation: string;
  /**
   * True when the file imports more than one AWS client and the command sat on a line that named
   * none of them. The call is real; which service it belongs to is then a guess, so the scan says
   * so rather than picking one.
   */
  readonly ambiguous?: boolean;
}

/**
 * `src/` TypeScript that is not a test, so a test's SDK use is not counted as a call.
 *
 * Textual and dependency-free on purpose: this has to answer "does the table still cover what we
 * call" in a checkout that has not installed anything, which is the state `make check` starts in.
 */
export function sourceFiles(
  root: string,
): readonly { readonly path: string; readonly text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
        walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        found.push({ path: path.replace(`${root}/`, ''), text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(join(root, 'src'));
  return found;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The gate
 * ──────────────────────────────────────────────────────────────────────────── */

export interface GateResult {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

/**
 * Completeness + provenance, as text. `tsir deploy:verify` prints the table; this judges it.
 *
 * `root` exists for one test: a tree that calls an operation with no row must fail the gate, and
 * that cannot be proved by pointing the gate at this repository, whose every call has a row.
 */
export function gate(
  options: { readonly source?: string | undefined; readonly root?: string | undefined } = {},
): GateResult {
  const surface = awsSurface(sourceFiles(options.root ?? ROOT));
  const missing = coverageProblems(surface);
  const lines: string[] = [];

  lines.push(`AWS Emulator ${EMULATOR_RELEASE} — is the table complete, and is it true?`);
  lines.push('');
  lines.push(
    `${String(OPERATIONS.length)} operations in the table; ${String(surface.length)} call sites found in src/`,
  );
  for (const row of OPERATIONS) {
    lines.push(`  ${row.verdict.padEnd(15)} ${row.operation.padEnd(24)} ${row.ours.path}`);
  }

  if (missing.length > 0) {
    lines.push('');
    lines.push(`Called with no row in ${EMULATOR_SELF} — the table is incomplete:`);
    for (const entry of missing) lines.push(`  ${entry}`);
  }

  let disagreements = 0;
  const src = options.source;
  if (src !== undefined && existsSync(src)) {
    const checks = crossCheck(src);
    lines.push('');
    lines.push(`Cross-check against the checkout at ${src}:`);
    for (const check of checks) {
      const detail =
        check.outcome === 'agrees'
          ? 'source agrees'
          : check.outcome === 'reviewed'
            ? `body written; the refusal is the reader’s — first code line: ${check.firstCodeLine ?? '(none)'}`
            : `DISAGREES — derived ${check.derived}, first code line: ${check.firstCodeLine ?? '(none)'}`;
      const size = check.sizeMismatch === undefined ? '' : ` [size ${check.sizeMismatch}]`;
      lines.push(`  ${check.outcome.padEnd(10)} ${check.operation.padEnd(14)} ${detail}${size}`);
      if (check.outcome === 'disagrees') disagreements += 1;
    }
  } else {
    lines.push('');
    lines.push('Cross-check against the vendored handlers:');
    for (const check of crossCheck()) {
      lines.push(
        `  ${check.outcome.padEnd(10)} ${check.operation.padEnd(24)} ${check.derived}` +
          (check.sizeMismatch === undefined ? '' : ` [size ${check.sizeMismatch}]`),
      );
      if (check.outcome === 'disagrees') disagreements += 1;
    }
  }

  if (disagreements > 0) {
    lines.push('');
    lines.push(
      `${String(disagreements)} verdict(s) no longer match the handlers — re-read the source.`,
    );
  }

  return { lines, exitCode: missing.length > 0 || disagreements > 0 ? 1 : 0 };
}

async function main(): Promise<void> {
  const sourceFlag = process.argv.indexOf('--source');
  const source = sourceFlag === -1 ? process.env['AWS_EMULATOR_SRC'] : process.argv[sourceFlag + 1];
  const result = gate(source === undefined || source === '' ? {} : { source });
  if (process.argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          release: EMULATOR_RELEASE,
          operations: OPERATIONS,
          missing: coverageProblems(awsSurface(sourceFiles(ROOT))),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${result.lines.join('\n')}\n`);
  }
  process.exitCode = result.exitCode;
}

if (import.meta.main) await main();
