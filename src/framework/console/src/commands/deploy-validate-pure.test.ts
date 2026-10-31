/**
 * The pure parts of `deploy:validate` (DPL-022, DPL-020): who can reach a unit, judged from the
 * files on disk, and which secret names the graph declares. No build directory is needed, so
 * these run in-process and count toward coverage.
 */

import { describe, expect, test } from 'bun:test';

import { exposureProblems, secretNamesOf } from './deploy-validate.ts';

// The shapes below are the parts of `ResolvedBuild` the two functions read.
type Unit = { name: string; private: boolean; bindings: { kind: string; name: string }[] };
const build = (units: Unit[]): Parameters<typeof secretNamesOf>[0] =>
  ({ graph: { units } }) as unknown as Parameters<typeof secretNamesOf>[0];

describe('secretNamesOf', () => {
  test('collects secret binding names across units, deduplicated and sorted', () => {
    const units: Unit[] = [
      {
        name: 'http',
        private: false,
        bindings: [
          { kind: 'secret', name: 'STRIPE_KEY' },
          { kind: 'var', name: 'APP_NAME' },
        ],
      },
      {
        name: 'worker',
        private: true,
        bindings: [
          { kind: 'secret', name: 'DB_PASSWORD' },
          { kind: 'secret', name: 'STRIPE_KEY' },
        ],
      },
    ];
    expect(secretNamesOf(build(units))).toEqual(['DB_PASSWORD', 'STRIPE_KEY']);
  });

  test('a graph with no secrets declares none', () => {
    expect(secretNamesOf(build([{ name: 'http', private: false, bindings: [] }]))).toEqual([]);
  });
});

describe('exposureProblems', () => {
  test('a private unit with a Cloudflare config that is publicly routable is a problem', () => {
    const result = exposureProblems(build([{ name: 'admin', private: true, bindings: [] }]), [
      { file: 'cloudflare/admin/wrangler.admin.toml', contents: 'name = "admin"\n' },
    ]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.unit).toBe('admin');
    expect(result.warnings).toEqual([]);
  });

  test('the same private unit with workers.dev disabled is fine', () => {
    const result = exposureProblems(build([{ name: 'admin', private: true, bindings: [] }]), [
      { file: 'cloudflare/admin/wrangler.admin.toml', contents: 'workers_dev = false\n' },
    ]);
    expect(result).toEqual({ problems: [], warnings: [] });
  });

  test('a public unit that disabled workers.dev is a warning, not a problem', () => {
    const result = exposureProblems(build([{ name: 'http', private: false, bindings: [] }]), [
      { file: 'cloudflare/http/wrangler.http.toml', contents: 'workers_dev = false\n' },
    ]);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      'http: the cloudflare artifact disables workers.dev but the unit is public in tsir.js',
    ]);
  });

  test('a private unit behind an API Gateway HTTP API is a problem on Lambda', () => {
    const template = 'Resources:\n  Api:\n    Type: HttpApi\n';
    const result = exposureProblems(build([{ name: 'billing', private: true, bindings: [] }]), [
      { file: 'lambda/billing/template.billing.yaml', contents: template },
    ]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.unit).toBe('billing');
  });

  test('a private unit with no artifacts on disk is not judged, so the check cannot invent a finding', () => {
    expect(exposureProblems(build([{ name: 'ghost', private: true, bindings: [] }]), [])).toEqual({
      problems: [],
      warnings: [],
    });
  });
});
