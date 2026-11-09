import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  documentationProblems,
  helpProblems,
  helpTargets,
  makefileProblems,
  makeMentions,
  parseMakefile,
  targetNames,
} from './check-make.ts';

const ROOT = resolve(import.meta.dir, '..', '..');

describe('tools · the Makefile gate (DXS-015)', () => {
  test('the real Makefile and the docs that name its targets are consistent', () => {
    const source = readFileSync(join(ROOT, 'Makefile'), 'utf8');
    expect(makefileProblems(source)).toEqual([]);
    const targets = targetNames(source);
    // A sanity floor: the parse found a Makefile, not an empty file that trivially passes.
    expect(targets.size).toBeGreaterThan(50);
    expect(targets.has('check')).toBe(true);
    expect(targets.has('dist-build')).toBe(true);
  });

  test('an undefined variable is reported, because make expands it to nothing', () => {
    const problems = makefileProblems(
      ['BUN ?= bun', 'hello:', '\t@echo "$(BUN) / $(COMPOSE)"', ''].join('\n'),
    );
    expect(problems.some((problem) => problem.includes('$(COMPOSE)'))).toBe(true);
  });

  test('a `?=` input and a make-provided variable are not undefined', () => {
    const problems = makefileProblems(
      ['.PHONY: hello', 'NAME ?= default', 'hello:', '\t@echo "$(NAME) in $(CURDIR)"', ''].join(
        '\n',
      ),
    );
    expect(problems).toEqual([]);
  });

  test('a definition nobody reads is reported, and `?=` is exempt', () => {
    const unused = makefileProblems(['UNUSED := value', 'hello:', '\t@echo hello', ''].join('\n'));
    expect(unused.some((problem) => problem.includes('UNUSED'))).toBe(true);

    const input = makefileProblems(
      ['.PHONY: hello', 'NAME ?= value', 'hello:', '\t@echo hello', ''].join('\n'),
    );
    expect(input).toEqual([]);
  });

  test('a target defined twice is reported, and so is one buried in a doc line', () => {
    const twice = makefileProblems(
      ['.PHONY: up', 'up:', '\t@echo one', 'up:', '\t@echo two', ''].join('\n'),
    );
    expect(twice.some((problem) => problem.includes('defined 2 times'))).toBe(true);

    // The shape a rebase produced: one rule whose `##` text carries a second definition.
    const merged = makefileProblems(
      [
        '.PHONY: db-up',
        'db-up: ## Start Postgres (needs Docker)db-up: ## Start Postgres on 5432',
        '\t@echo up',
        '',
      ].join('\n'),
    );
    expect(merged.some((problem) => problem.includes('second definition buried'))).toBe(true);
  });

  test('every target is .PHONY, and .PHONY names only real targets', () => {
    const missing = makefileProblems(['hello:', '\t@echo hello', ''].join('\n'));
    expect(missing.some((problem) => problem.includes('not declared .PHONY'))).toBe(true);

    const ghost = makefileProblems(
      ['.PHONY: hello gone', 'hello:', '\t@echo hello', ''].join('\n'),
    );
    expect(ghost.some((problem) => problem.includes('"gone"'))).toBe(true);
  });

  test('a continued .PHONY line is read as one declaration', () => {
    const problems = makefileProblems(
      [
        '.PHONY: a b \\',
        '        c',
        'a:',
        '\t@echo a',
        'b:',
        '\t@echo b',
        'c:',
        '\t@echo c',
        '',
      ].join('\n'),
    );
    expect(problems).toEqual([]);
  });

  test('a comment mentioning a variable does not count as reading it', () => {
    const problems = makefileProblems(
      ['.PHONY: hello', '# $(GHOST) is prose here', 'hello:', '\t@echo hello', ''].join('\n'),
    );
    expect(problems).toEqual([]);
  });

  test('recipe lines read variables but never define targets', () => {
    const parsed = parseMakefile(
      ['.PHONY: build', 'build:', '\t@echo "note: label"', '\t@$(MAKE) inner', ''].join('\n'),
    );
    expect(parsed.targets.map((target) => target.name)).toEqual(['build']);
    expect(parsed.used.has('MAKE')).toBe(true);
  });
});

describe('tools · a document may only name a target that exists', () => {
  const targets = new Set(['check', 'dist-build', 'db-up']);

  test('a code span is a command, so a target that is gone is reported', () => {
    const problems = documentationProblems(targets, [
      { path: 'docs/old.md', source: 'Run `make migrate` first.\n' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('make migrate');
  });

  test('a target that exists is not reported, and arguments are stripped', () => {
    const problems = documentationProblems(targets, [
      { path: 'docs/ok.md', source: 'Run `make check CI=1` or `make db-up`.\n' },
    ]);
    expect(problems).toEqual([]);
  });

  test('ordinary English is not a command', () => {
    const sentences = [
      'Delivery is not exactly-once, and no test can make it so.',
      'A module left out of that list cannot make a failure stop the request.',
      'The P0 target would make self-hosted deployments first-class.',
      'which modules make up this app and their lifecycle',
    ].join('\n');
    expect(makeMentions(sentences)).toEqual([]);
  });

  test('a fenced block is a transcript, so every command in it counts', () => {
    const problems = documentationProblems(targets, [
      { path: 'docs/readme.md', source: '```sh\nmake build\nmake check\n```\n' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('make build');
  });

  test('a line with two code spans does not turn the prose between them into code', () => {
    // The bug this covers: matching from one backtick to the next `make` treated `stubs/`'s
    // closing tick as an opening one, and reported "make it" on a line naming no command.
    const prose = '`package.json` to read, and no `stubs/` directory. Two things make it work.\n';
    expect(makeMentions(prose)).toEqual([]);
  });

  test('a namespaced CLI command is not a Make target', () => {
    expect(makeMentions('Run `tsir make:controller user --module=users`.\n')).toEqual([]);
  });

  test('a line that starts with the command is a mention even without backticks', () => {
    const problems = documentationProblems(targets, [
      { path: 'docs/transcript.md', source: '    make deploy-plan\n' },
    ]);
    expect(problems).toHaveLength(1);
  });

  test('the line number points at the mention, not the document', () => {
    const problems = documentationProblems(targets, [
      { path: 'docs/two.md', source: '# Title\n\nRun `make gone`.\n' },
    ]);
    expect(problems[0]).toStartWith('docs/two.md:3');
  });
});

describe('tools · make help lists what exists', () => {
  /** A Makefile with one help recipe, in the shape `printf` actually receives. */
  const makefile = (names: readonly string[], targets: readonly string[]): string =>
    [
      '.PHONY: help ' + targets.join(' '),
      'help: ## Show targets',
      ...names.map((name) => `\t@printf '  \\033[36mmake ${name}\\033[0m  what it does\\n'`),
      ...targets.map((name) => `${name}: ## ${name}`),
      '\t@echo done',
      '',
    ].join('\n');

  test('a target the listing never mentions is reported', () => {
    const source = makefile(['check'], ['check', 'release-pack']);
    expect(helpProblems(targetNames(source), helpTargets(source))).toEqual([
      expect.stringContaining('"release-pack"'),
    ]);
  });

  test('a listed target is not reported, and the escape is read from the right side of `make`', () => {
    // The first draft looked for `make` followed by the escape; the file has the escape first.
    const source = makefile(['check', 'release-pack'], ['check', 'release-pack']);
    expect([...helpTargets(source)].sort()).toEqual(['check', 'release-pack']);
    expect(helpProblems(targetNames(source), helpTargets(source))).toEqual([]);
  });

  test('a listing that advertises a target nobody defined is reported', () => {
    const source = makefile(['check', 'gone'], ['check']);
    expect(helpProblems(targetNames(source), helpTargets(source))).toEqual([
      expect.stringContaining('"gone"'),
    ]);
  });

  test('a deliberately derivative target is exempt, and the exemption is not a blanket', () => {
    // `format-check` is the verify-only half of `format`; `release-pack` is a real task.
    const source = makefile(['format'], ['format', 'format-check', 'release-pack']);
    const problems = helpProblems(targetNames(source), helpTargets(source));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('release-pack');
  });

  test('the real Makefile lists every target a reader would reach for', () => {
    const source = readFileSync(join(ROOT, 'Makefile'), 'utf8');
    expect(helpProblems(targetNames(source), helpTargets(source))).toEqual([]);
    // The three gates added this cycle are the ones that were missing.
    const listed = helpTargets(source);
    for (const name of ['make-check', 'compile-cli', 'verify-templates']) {
      expect(listed.has(name)).toBe(true);
    }
  });
});
