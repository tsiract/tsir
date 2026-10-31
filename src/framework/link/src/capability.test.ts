/**
 * The capability matrix is a claim about code (`Gate P5`).
 *
 * `README.md` in the package root tells a reader which protocols work on which target. A table
 * like that rots the moment someone adds an import, so this file reads the table and checks the
 * two things it can check mechanically:
 *
 *   · a cell that says ❌ for Workers must correspond to code that *refuses* there rather
 *     than failing mysteriously at runtime (`assertGrpcSupported`);
 *   · a cell that says ✅ for Workers must correspond to an entrypoint that imports no
 *     `node:` or `bun:` module — a bundle for Workers cannot resolve one.
 *
 * It cannot prove behaviour on a real Lambda. `make verify-dist` bundles and boots each
 * target, which is the closest a laptop gets, and the limit is stated here.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assertGrpcSupported, grpcSupported } from './grpc.ts';

const ROOT = resolve(import.meta.dir, '..');
const PLAN = readFileSync(join(ROOT, 'README.md'), 'utf8');
const SOURCE = join(import.meta.dir);

/** The README's capability table, as `capability → target → cell`. */
function matrix(): Map<string, Map<string, string>> {
  const section = PLAN.slice(PLAN.indexOf('## Capability matrix'));
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---'))
    .slice(1); // drop the header row

  const table = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [capability, ...targets] = cells;
    if (capability === undefined) continue;
    table.set(
      capability,
      new Map([
        ['Bun', targets[0] ?? ''],
        ['Workers', targets[1] ?? ''],
        ['Lambda', targets[2] ?? ''],
      ]),
    );
  }
  return table;
}

/** Every import specifier in a source file, so `node:` can be searched for honestly. */
function importSpecifiers(file: string): readonly string[] {
  const text = readFileSync(join(SOURCE, file), 'utf8');
  return [...text.matchAll(/from '([^']+)'/gu)].map((match) => match[1] ?? '');
}

describe('capability matrix (Gate P5)', () => {
  test('every protocol row is present for all three targets', () => {
    const table = matrix();

    for (const capability of [
      'REST client',
      'REST server',
      'gRPC client',
      'gRPC server',
      'SOAP client',
      'SOAP server',
      'WS client',
      'WS server',
      'Deadline propagation',
      'Cancellation',
    ]) {
      const row = table.get(capability);
      expect({ capability, row: row !== undefined }).toEqual({ capability, row: true });
      expect(row?.size).toBe(3);
    }
  });

  test('a ❌ for Workers is a refusal in code, not a runtime surprise', () => {
    const row = matrix().get('gRPC client');
    expect(row?.get('Workers')).toStartWith('❌');

    // Workers has no `process.versions.node`; Bun and Node both do.
    expect(grpcSupported({ process: { versions: { node: '20.11.0' } } })).toBe(true);
    expect(grpcSupported({})).toBe(false);
    expect(() => {
      assertGrpcSupported({});
    }).toThrow(/http2/);
  });

  test('a ✅ for Workers is an entrypoint with no node: or bun: import', () => {
    const table = matrix();
    const workersCapable: readonly [string, readonly string[]][] = [
      ['REST client', ['rest.ts']],
      [
        'SOAP client',
        ['soap.ts', 'soap-core.ts', 'soap-shape.ts', 'soap-server.ts', 'xml.ts', 'wsse.ts'],
      ],
      ['WS client', ['ws.ts', 'rooms.ts']],
    ];

    for (const [capability, files] of workersCapable) {
      expect({ capability, cell: table.get(capability)?.get('Workers')?.startsWith('✅') }).toEqual(
        {
          capability,
          cell: true,
        },
      );

      for (const file of files) {
        const platform = importSpecifiers(file).filter(
          (specifier) => specifier.startsWith('node:') || specifier.startsWith('bun:'),
        );
        expect({ file, platform }).toEqual({ file, platform: [] });
      }
    }
  });

  test('the gRPC entrypoint is the only one that needs a platform transport', () => {
    const specs = importSpecifiers('grpc.ts');
    expect(specs).toContain('@grpc/grpc-js');

    // …and the shared core stays free of it, which is what makes REST+SOAP+WS bundle for
    // Workers without a gRPC runtime (ADR-0022, proved again in `make verify-dist`).
    for (const file of ['index.ts', 'types.ts', 'errors.ts', 'retry.ts', 'breaker.ts']) {
      expect({ file, grpc: importSpecifiers(file).filter((s) => s.includes('grpc')) }).toEqual({
        file,
        grpc: [],
      });
    }
  });
});
