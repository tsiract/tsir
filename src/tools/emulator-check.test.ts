/**
 * The AWS Emulator table's own gate.
 *
 * Three things can go wrong with the table, and each one has a test here because each one happened
 * while it was being written:
 *
 *   · **the selector reads the wrong line.** The first version looked for the first code line after
 *     `fn handle`, found `&self,` from the four-line signature, and reported a working `Invoke` as
 *     unimplemented. `selectorsIn` now brace-matches to the body, and the real handlers in
 *     `console/src/commands/fixtures/aws-emulator/` are the fixtures that prove it.
 *   · **a verdict is asserted instead of derived.** Every row is re-derived from the vendored
 *     handler sources; the test fails if any disagrees or if a size moved.
 *   · **a call exists with no row.** The table is only worth reading while it is complete, so a
 *     scan of `src/` for SDK commands and wire calls must find nothing unaccounted for.
 *
 * These live beside the gate rather than beside the table because they are questions about **this
 * repository**: the table describes tsir's AWS surface and ships in `@tsir/console`, while the scan
 * that keeps it honest reads a tree only this checkout has. Splitting them is what stops
 * `tsir deploy:verify` — a command an application runs — from failing because the *application*
 * calls AWS.
 *
 * The vendored fixture is 13 files from the emulator at `EMULATOR_RELEASE` — the table's evidence,
 * which cannot be fetched in CI. Where it comes from, and why it is vendored rather than cloned, is
 * recorded in the AWS Emulator review of 2026-11-13.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { EMULATOR_RELEASE, OPERATIONS } from '../framework/console/src/commands/emulator.ts';
import {
  awsSurface,
  codeOnly,
  coverageProblems,
  crossCheck,
  gate,
  isCodeLine,
  observedCrates,
  selectorsIn,
  sourceFiles,
  verdictFor,
} from './emulator-check.ts';

/** `src/tools/emulator-check.test.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');
const FIXTURE = join(
  ROOT,
  'src',
  'framework',
  'console',
  'src',
  'commands',
  'fixtures',
  'aws-emulator',
);

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

describe('gate · the repository check `make emulator-check` runs', () => {
  test('this repository passes: every call has a row and every verdict is still true', () => {
    const result = gate();
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('13 operations in the table');
  });

  test('an uncovered AWS call fails the gate — the half that must never ship in the command', () => {
    const tree = mkdtempSync(join(tmpdir(), 'tsir-emulator-gate-'));
    try {
      mkdirSync(join(tree, 'src', 'app'), { recursive: true });
      writeFileSync(
        join(tree, 'src', 'app', 'uncovered.ts'),
        "import { SQSClient, PurgeQueueCommand } from '@aws-sdk/client-sqs';\n" +
          'export const client = new SQSClient({});\n' +
          'export const purge = (input: unknown): unknown => new PurgeQueueCommand(input as never);\n',
        'utf8',
      );
      const result = gate({ root: tree });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('the table is incomplete');
      expect(result.lines.join('\n')).toContain('PurgeQueue');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('codeOnly · a comment is not a call', () => {
  test('a path named in prose is not counted as a wire call', () => {
    // This gate's own header names `/v2/email/outbound-emails`, and it reported itself as a site.
    const text = [
      '/**',
      ' * the hand-written send posts to /v2/email/outbound-emails',
      ' */',
      'export const x = 1;',
      '// and this line mentions /v2/email/outbound-emails too',
    ].join('\n');
    expect(codeOnly(text)).toBe('export const x = 1;');
  });

  test('a wire call in code survives', () => {
    const text = [
      '/* header */',
      'const url = `https://email.x.amazonaws.com/v2/email/outbound-emails`;',
    ].join('\n');
    expect(codeOnly(text)).toContain('outbound-emails');
  });
});
