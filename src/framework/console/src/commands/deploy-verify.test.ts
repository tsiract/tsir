/**
 * `tsir deploy:verify` describes *tsir's* AWS surface to the project in front of the developer.
 *
 * These tests exist because the first version of this command did more than that, and the extra
 * was a defect rather than a feature: it scanned the caller's `src/` and exited `1` when the
 * caller used an AWS operation with no row. A project that calls something the emulator does not
 * implement has learned a fact about the emulator — reporting it is the answer, failing is not.
 *
 * So the property under test is not "the table is right" (that is `make emulator-check`'s
 * question, and its tests live in `src/tools/emulator-check.test.ts`). It is the boundary:
 * the command prints, and it returns `0` regardless of what it finds.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { verify } from './emulator.ts';

const realOut = process.stdout.write.bind(process.stdout);
let captured = '';

const capture = (): void => {
  captured = '';
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
};

afterEach(() => {
  process.stdout.write = realOut;
});

describe('deploy:verify · reports, never judges the caller', () => {
  test('prints the table and exits 0, with no credentials and no emulator running', async () => {
    capture();
    const code = await verify([]);

    expect(code).toBe(0);
    expect(captured).toContain('AWS Emulator');
    expect(captured).toContain('SendMessage');
    expect(captured).toContain('Probe skipped');
  });

  test('`--json` is a versioned document, not a bare object', async () => {
    capture();
    const code = await verify(['--json']);

    expect(code).toBe(0);
    const document: unknown = JSON.parse(captured);
    expect(document).toHaveProperty('schemaVersion');
    expect(document).toHaveProperty('operations');
  });

  test('states the limits rather than leaving a reader to infer them from exit 0', async () => {
    // An advisory command has one obligation: the reader must not mistake silence for proof.
    capture();
    await verify([]);
    expect(captured).toMatch(/C4|initDuration/u);
    expect(captured).toMatch(/connect|emulator/iu);
  });

  test('reads nothing from a caller tree — there is no `--root`, and an unknown flag is ignored', async () => {
    // The command's argument surface is deliberately empty apart from `--json`: a flag that names
    // a directory is how the scan leaked into the command in the first place.
    capture();
    const code = await verify(['--root', '/nonexistent']);
    expect(code).toBe(0);
    expect(captured).toContain('SendMessage');
  });
});
