/**
 * The AWS Emulator table's own gate.
 *
 * Three things can go wrong with a table like `src/framework/console/src/commands/emulator.ts`, and each one has a
 * test here because each one happened during the writing of it:
 *
 *   · **the selector reads the wrong line.** The first version looked for the first code line
 *     after `fn handle`, found `&self,` from the four-line signature, and reported a working
 *     `Invoke` as unimplemented. `selectorsIn` now brace-matches to the body, and the real
 *     handlers in `fixtures/aws-emulator/` are the fixtures that prove it.
 *   · **a verdict is asserted instead of derived.** Every row is re-derived from the vendored
 *     handler sources; the test fails if any disagrees or if a size moved.
 *   · **a call exists with no row.** The table is only worth reading while it is complete, so a
 *     scan of `src/` for SDK commands and wire calls must find nothing unaccounted for.
 *
 * The vendored fixture is 13 files from the emulator at `EMULATOR_RELEASE` — the *Table*'s
 * evidence, which cannot be fetched in CI. Where it comes from, and why it is vendored rather
 * than cloned, is recorded in the AWS Emulator review of 2026-11-13.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EMULATOR_RELEASE,
  OPERATIONS,
  awsSurface,
  coverageProblems,
  crossCheck,
  isCodeLine,
  observedCrates,
  readSetup,
  selectorsIn,
  sourceFiles,
  verdictFor,
} from './emulator.ts';

/** The repository root, five edges up from `src/framework/console/src/commands`. */
const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const FIXTURE = join(import.meta.dir, 'fixtures', 'aws-emulator');

const handler = (crate: string, file: string): string =>
  readFileSync(join(FIXTURE, 'services', crate, 'src', 'ops', file), 'utf8');

describe('selectorsIn · the first line of code in the body', () => {
  test('it skips a four-line signature, which is where the first version failed', () => {
    const source = `
    async fn handle(
        &self,
        input: Self::Input,
        ctx: &smithy_server_runtime::OperationContext<'_>,
    ) -> Result<Self::Output, Self::Error> {
        // a comment is not the first line of code
        if input.message_body.is_empty() {
`;
    expect(selectorsIn(source)).toBe('if input.message_body.is_empty() {');
  });

  test('a one-line signature still finds the statement after it', () => {
    expect(selectorsIn('fn handle() {\n    let _ = ctx;\n}\n')).toBe('let _ = ctx;');
  });

  test('a file with no fn handle is absent, not empty', () => {
    expect(selectorsIn('// the operation is not here\n')).toBeUndefined();
  });

  test('real handlers resolve to the statement the scaffolder writes, not to a parameter', () => {
    const send = selectorsIn(handler('service-com-amazonaws-sqs-amazonsqs', 'send_message.rs'));
    expect(send).toBe('if input.message_body.is_empty() {');
    // The regression this file exists for: the old selector answered `&self,` for this handler.
    const invoke = selectorsIn(
      handler('service-com-amazonaws-lambda-awsgirapiservice', 'invoke.rs'),
    );
    expect(invoke).not.toBe('&self,');
    expect(invoke).toBe('crate::state::admitted_qualifier(input.qualifier.as_deref())?;');
  });
});

describe('verdictFor · what a first line means', () => {
  test('the scaffold refusal and a hollow success are both `stub`', () => {
    expect(verdictFor('return Err(crate::scaffolded::Scaffolded::not_implemented("X"));')).toBe(
      'stub',
    );
    expect(verdictFor('Ok(Self::Output::default())')).toBe('stub');
    expect(verdictFor('Ok(default())')).toBe('stub');
  });

  test('a Unit-input handler that refuses afterwards is `unknown`, not a silent pass', () => {
    expect(verdictFor('let _ = (&input, ctx);')).toBe('unknown');
    expect(verdictFor('let _ = ctx;')).toBe('written');
  });

  test('no handler file is `absent`', () => {
    expect(verdictFor(undefined)).toBe('absent');
  });

  test('reading the request is `written`, which is not yet a verdict about service', () => {
    expect(verdictFor('let Some(state) = crate::state::service_state(&*self.engine) else {')).toBe(
      'written',
    );
  });

  test('isCodeLine rejects exactly the lines a scaffold interleaves', () => {
    for (const line of ['', '   ', '// x', '/// x', '#[cfg(unix)]', '/* x */', ' * x']) {
      expect(isCodeLine(line)).toBe(false);
    }
    for (const line of ['let x = 1;', 'if x {', '&self,']) expect(isCodeLine(line)).toBe(true);
  });
});

describe('crossCheck · every verdict re-derived from the vendored handlers', () => {
  test('the fixture is the pinned release, not a moving checkout', () => {
    // The vendored files are trimmed to `fn handle`-bearing content only where the emulator's
    // SPDX line is its first line; a release change would move these sizes first.
    expect(EMULATOR_RELEASE).toBe('v1.0.341');
    const invoke = handler('service-com-amazonaws-lambda-awsgirapiservice', 'invoke.rs');
    expect(invoke.startsWith('// SPDX-License-Identifier: CC0-1.0')).toBe(true);
  });

  test('no row disagrees with its source, and no handler size moved', () => {
    const checks = crossCheck(FIXTURE);
    expect(checks).toHaveLength(OPERATIONS.length);
    const wrong = checks.filter((check) => check.outcome === 'disagrees');
    expect(wrong.map((check) => `${check.operation}: ${check.derived}`)).toEqual([]);
    const moved = checks.filter((check) => check.sizeMismatch !== undefined);
    expect(moved.map((check) => `${check.operation} ${check.sizeMismatch ?? ''}`)).toEqual([]);
  });

  test('a served row claims a written body, and the Invoke row is the regression it caught', () => {
    const invoke = crossCheck(FIXTURE).find((check) => check.operation === 'Invoke');
    expect(invoke?.claimed).toBe('served');
    expect(invoke?.derived).toBe('written');
  });

  test('a missing checkout reports absence rather than passing quietly', () => {
    const checks = crossCheck(join(FIXTURE, 'nowhere'));
    expect(checks.every((check) => check.derived === 'absent')).toBe(true);
    expect(checks.some((check) => check.outcome === 'disagrees')).toBe(true);
  });
});

describe('awsSurface · the calls our own source makes', () => {
  test('a lazy SDK import is found, with the operation its command names', () => {
    const surface = awsSurface([
      {
        path: 'x.ts',
        text: "const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');\nnew PublishCommand({});",
      },
    ]);
    expect(surface.map((entry) => entry.operation)).toEqual([
      'service-com-amazonaws-sns-amazonsimplenotificationservice:Publish',
    ]);
  });

  test('a hand-written wire call is found even though it imports no SDK', () => {
    const surface = awsSurface([
      {
        path: 'ses.ts',
        text: 'const url = `https://email${region}.amazonaws.com/v2/email/outbound-emails`;',
      },
    ]);
    expect(surface[0]?.operation).toBe(
      'service-com-amazonaws-sesv2-simpleemailservice-v2:SendEmail',
    );
  });

  test('a file that mentions neither contributes nothing, and duplicates collapse', () => {
    expect(observedCrates('import { x } from "@tsir/core"')).toEqual([]);
    const twice = awsSurface([
      {
        path: 'a.ts',
        text: "import('@aws-sdk/client-sqs'); new SendMessageCommand({}); new SendMessageCommand({});",
      },
    ]);
    expect(twice).toHaveLength(1);
  });

  test('a command in a file with two clients is attributed by its own import line', () => {
    // The shape `src/framework/deploy/src/internal.ts` really has: two lazy imports, three
    // commands, every one destructured from the statement that names its package.
    const text = [
      "const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');",
      "const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');",
      "const { ListTopicsCommand } = await import('@aws-sdk/client-sns');",
    ].join('\n');
    expect(awsSurface([{ path: 'internal.ts', text }]).map((entry) => entry.operation)).toEqual([
      'service-com-amazonaws-sns-amazonsimplenotificationservice:Publish',
      'service-com-amazonaws-lambda-awsgirapiservice:Invoke',
      'service-com-amazonaws-sns-amazonsimplenotificationservice:ListTopics',
    ]);
  });

  test('a command no import line names is ambiguous, not attributed by guess', () => {
    const text = [
      "import('@aws-sdk/client-sns');",
      "import('@aws-sdk/client-lambda');",
      'new TellMeCommand({});',
    ].join('\n');
    const surface = awsSurface([{ path: 'x.ts', text }]);
    expect(surface).toHaveLength(2);
    expect(surface.every((entry) => entry.ambiguous === true)).toBe(true);
    // Ambiguity is not a pass: a call with no row in ANY candidate service still fails.
    expect(coverageProblems(surface)).toEqual([
      'TellMe (could be service-com-amazonaws-sns-amazonsimplenotificationservice or service-com-amazonaws-lambda-awsgirapiservice) (called from x.ts)',
    ]);
  });

  test('a declaration file names command shapes without calling them', () => {
    const surface = awsSurface([
      {
        path: 'src/framework/deploy/src/aws-sdk.d.ts',
        text: "declare module '@aws-sdk/client-sns' {\n  export class PublishCommand {}\n}",
      },
    ]);
    expect(surface).toEqual([]);
  });

  test('every operation src/ calls has a row — the table is complete or this fails', () => {
    const surface = awsSurface(sourceFiles(ROOT));
    expect(surface.length).toBeGreaterThan(0);
    expect(coverageProblems(surface)).toEqual([]);
  });

  test('an uncovered call is reported by name, not silently dropped', () => {
    const problems = coverageProblems([
      { path: 'src/x.ts', operation: 'service-com-amazonaws-sqs-amazonsqs:DeleteQueue' },
    ]);
    expect(problems).toEqual([
      'service-com-amazonaws-sqs-amazonsqs:DeleteQueue (called from src/x.ts)',
    ]);
  });
});

describe('readSetup · the emulator’s own credential layout', () => {
  test('an absent home directory is `undefined`, not a throw', () => {
    expect(readSetup('/nonexistent-home', 9297)).toBeUndefined();
  });
});
