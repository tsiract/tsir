/**
 * The three contracts a pull request can rename silently (`DOCS-011`).
 *
 * `check-docs-in-pr.ts` refuses a branch that changes the public export surface (or any framework
 * source) without touching a document. That catches a renamed *export*, and misses the three things
 * a user types:
 *
 *   · **a `tsir.js` top-level key** — `PROJECT_TOP_LEVEL_KEYS` in `@tsir/config`;
 *   · **a CLI command** — `COMMANDS` in `@tsir/console`;
 *   · **an error code** — the committed baseline in `src/docs/error-codes.json`, which
 *     `check-error-codes.ts` already treats as append-only.
 *
 * The snapshot (`src/docs/contracts.json`) is committed. Two things read it:
 *
 *   · **this gate**, which runs in `make check` with no git base and fails when a name in the
 *     snapshot no longer exists in the code — a rename shows up as a removal here, and the fix is
 *     to document it and re-run `--write` in the same commit;
 *   · **`check-docs-in-pr`**, which has the changed paths and can therefore ask the stricter
 *     question: was the removal accompanied by a document change?
 *
 * An *addition* is never a failure. A new command that no page mentions yet is every branch
 * mid-feature; the docs gates own the docs tree.
 *
 *   bun src/tools/check-contracts.ts          # gate (CI, `make check`)
 *   bun src/tools/check-contracts.ts --write  # after adding or deliberately renaming a name
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_TOP_LEVEL_KEYS } from '../framework/config/src/project-file.ts';
import { COMMANDS } from '../framework/console/src/index.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
export const SNAPSHOT = resolve(ROOT, 'src/docs/contracts.json');
const ERROR_CODES = resolve(ROOT, 'src/docs/error-codes.json');

/** What a name belongs to, and which changed paths count as documenting its removal. */
export interface Contract {
  readonly name: 'config' | 'commands' | 'errors';
  readonly values: readonly string[];
  readonly documents: readonly RegExp[];
}

function errorCodes(): readonly string[] {
  if (!existsSync(ERROR_CODES)) return [];
  const parsed = JSON.parse(readFileSync(ERROR_CODES, 'utf8')) as {
    codes?: Record<string, string>;
  };
  return Object.keys(parsed.codes ?? {}).sort();
}

export function contractsIn(): readonly Contract[] {
  return [
    {
      name: 'config',
      values: [...PROJECT_TOP_LEVEL_KEYS].sort(),
      // A document, not the file that performs the rename: the config package is where the key was
      // removed, so counting it as documentation would make every rename self-documenting.
      documents: [/^src\/docs\//u, /^README\.md$/u],
    },
    {
      name: 'commands',
      values: COMMANDS.map((command) => command.name).sort(),
      documents: [/^src\/docs\//u, /^README\.md$/u],
    },
    // An error code is append-only (`check-error-codes.ts`), so no document can make removing one
    // acceptable. The pattern is empty on purpose: the list is here for the count, not the rule.
    { name: 'errors', values: errorCodes(), documents: [] },
  ];
}

export interface Contracts {
  readonly [name: string]: readonly string[];
}

export function currentContracts(): Contracts {
  const out: Record<string, readonly string[]> = {};
  for (const contract of contractsIn()) out[contract.name] = contract.values;
  return out;
}

export function readSnapshot(path: string = SNAPSHOT): Contracts {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Contracts;
}

export interface ContractProblem {
  readonly contract: string;
  readonly name: string;
  readonly message: string;
}

/** Names in `before` that are gone from `after`, per contract. */
export function removedNames(
  before: Contracts,
  after: Contracts,
): readonly { readonly contract: string; readonly name: string }[] {
  const removed: { contract: string; name: string }[] = [];
  // Not `contractsIn()`: a name this branch renamed is already gone from the current code, so
  // iterating the live registry would skip exactly the removal being looked for. The union of both
  // sides is the only list that contains it.
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const current = new Set(after[name] ?? []);
    for (const value of before[name] ?? []) {
      if (!current.has(value)) removed.push({ contract: name, name: value });
    }
  }
  return removed;
}

/**
 * Removals a branch has not explained.
 *
 * `changed` is the branch's file list. An error code is a failure whatever changed; a `tsir.js` key
 * or a command is a failure only when nothing in its documentation set moved, because the point is
 * that the page explaining the key has to change with it.
 */
export function contractProblems(
  before: Contracts,
  after: Contracts,
  changed: readonly string[],
): readonly ContractProblem[] {
  const problems: ContractProblem[] = [];
  const removed = removedNames(before, after);

  for (const contract of contractsIn()) {
    const gone = removed.filter((entry) => entry.contract === contract.name);
    if (gone.length === 0) continue;

    if (contract.name === 'errors') {
      for (const entry of gone) {
        problems.push({
          contract: contract.name,
          name: entry.name,
          message: `error code ${entry.name} was removed; codes are append-only — deprecate it instead`,
        });
      }
      continue;
    }

    const documented = changed.some((path) =>
      contract.documents.some((pattern) => pattern.test(path)),
    );
    if (documented) continue;

    for (const entry of gone) {
      problems.push({
        contract: contract.name,
        name: entry.name,
        message:
          contract.name === 'config'
            ? `\`tsir.js\` key ${entry.name} was removed or renamed with no documentation change`
            : `CLI command ${entry.name} was removed or renamed with no documentation change`,
      });
    }
  }
  return problems;
}

function main(): number {
  const after = currentContracts();
  if (process.argv.includes('--write')) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(after, null, 2)}\n`);
    process.stdout.write(
      `✓ src/docs/contracts.json written (` +
        contractsIn()
          .map((contract) => `${String(contract.values.length)} ${contract.name}`)
          .join(', ') +
        ')\n',
    );
    return 0;
  }

  if (!existsSync(SNAPSHOT)) {
    process.stderr.write(
      '✗ src/docs/contracts.json is missing — run `bun src/tools/check-contracts.ts --write`\n',
    );
    return 1;
  }

  const before = readSnapshot();
  const removed = removedNames(before, after);
  const added = contractsIn().flatMap((contract) => {
    const previous = new Set(before[contract.name] ?? []);
    return contract.values
      .filter((name) => !previous.has(name))
      .map((name) => `${contract.name} ${name}`);
  });

  if (removed.length > 0) {
    process.stderr.write(
      `\n${String(removed.length)} user-facing contract name(s) disappeared:\n\n`,
    );
    for (const entry of removed) {
      process.stderr.write(`  ✗ ${entry.contract}: ${entry.name}\n`);
    }
    process.stderr.write(
      '\n  A name people type is a contract. Document the rename, then run' +
        '\n  `bun src/tools/check-contracts.ts --write` in the same commit. An error code is' +
        '\n  append-only: deprecate it instead of deleting it.\n\n',
    );
    return 1;
  }

  process.stdout.write(
    `✓ user-facing contracts hold (${contractsIn()
      .map((contract) => `${String(contract.values.length)} ${contract.name}`)
      .join(', ')})` +
      (added.length > 0
        ? `\n  · new since the snapshot: ${added.join(', ')} — run --write to accept`
        : '') +
      '\n',
  );
  return 0;
}

if (import.meta.main) process.exitCode = main();
