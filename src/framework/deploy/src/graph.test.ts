/**
 * The unit graph (`DPL-001`, `DPL-002`, `DPL-004`, `DPL-006`).
 *
 * Three properties are worth the whole file:
 *
 *   1. **The deploy shape follows declarations, not folders.** The same routes produce the
 *      same units whether they are grouped by module or listed flat.
 *   2. **`separate` is the default and `single` is opt-in**, and the merge is reported.
 *   3. **Drift is named.** A moved route, a gained binding, a new migration unit each show
 *      up as a specific line, because "the graph changed" is not a reviewable statement.
 */

import { describe, expect, test } from 'bun:test';
import { TsirError } from '@tsir/core';

import {
  applyTopology,
  buildGraph,
  checkGraph,
  describeDiff,
  diffGraphs,
  explainGraph,
  formatGraph,
  graphJson,
  parseGraph,
  resolveUnits,
  serializeGraph,
  assertTarget,
  type DeploymentInput,
  type UnitGraph,
} from './index.ts';

const base: DeploymentInput = {
  appName: 'acme',
  routes: [
    { method: 'GET', path: '/health', unit: 'admin', module: 'ops' },
    { method: 'GET', path: '/api/orders', module: 'orders' },
    { method: 'POST', path: '/api/orders', module: 'orders' },
  ],
  modules: [
    { name: 'orders', requires: [] },
    { name: 'ops', requires: [] },
  ],
};

describe('unit resolution (DPL-001)', () => {
  test('routes land in `http` unless they say otherwise', () => {
    const units = resolveUnits(base);

    expect(units.map((unit) => unit.name)).toEqual(['admin', 'http']);
    const http = units.find((unit) => unit.name === 'http');
    expect(http?.triggers).toEqual([
      { kind: 'http', detail: ['GET /api/orders', 'POST /api/orders'] },
    ]);
    expect(http?.modules).toEqual(['orders']);
  });

  test('`admin` is private by default and `http` is not', () => {
    const units = resolveUnits(base);

    expect(units.find((unit) => unit.name === 'admin')?.private).toBe(true);
    expect(units.find((unit) => unit.name === 'http')?.private).toBe(false);
  });

  test('every unit records the declaration that demanded it', () => {
    const units = resolveUnits(base);

    expect(units.find((unit) => unit.name === 'admin')?.reasons).toEqual([
      { source: 'routes', from: 'GET /health' },
    ]);
  });

  test('a module requirement becomes a unit requirement', () => {
    const units = resolveUnits({
      appName: 'acme',
      routes: [{ method: 'GET', path: '/feed', module: 'feed' }],
      modules: [{ name: 'feed', requires: ['raw-sockets'] }],
    });

    expect(units[0]?.requires).toEqual(['raw-sockets']);
  });

  test('journaled connections become migrate units; unjournaled ones do not', () => {
    const units = resolveUnits({
      appName: 'acme',
      connections: [
        { name: 'primary', journal: true },
        { name: 'analytics', journal: false },
      ],
    });

    expect(units.map((unit) => unit.name)).toEqual(['migrate:primary']);
    expect(units[0]?.kind).toBe('migrate');
  });

  test('sockets, queues and schedules each get their own kind of trigger', () => {
    const units = resolveUnits({
      appName: 'acme',
      sockets: [{ path: '/ws/orders' }],
      queues: [{ name: 'emails' }],
      schedules: [{ name: 'nightly', cron: '0 2 * * *' }],
    });

    expect(units.map((unit) => [unit.name, unit.kind])).toEqual([
      ['queue', 'queue'],
      ['schedule', 'schedule'],
      ['ws', 'ws'],
    ]);
    expect(units.find((unit) => unit.name === 'schedule')?.triggers).toEqual([
      { kind: 'cron', detail: ['0 2 * * *'] },
    ]);
  });

  test('an override adds a unit this version cannot discover, and says so', () => {
    const units = resolveUnits({
      appName: 'acme',
      deploy: {
        units: [
          {
            name: 'drain',
            kind: 'schedule',
            triggers: [{ kind: 'cron', detail: ['*/5 * * * *'] }],
            requires: ['background-tasks'],
          },
        ],
      },
    });

    expect(units[0]).toMatchObject({
      name: 'drain',
      kind: 'schedule',
      requires: ['background-tasks'],
      reasons: [{ source: 'override', from: 'deploy.units.drain' }],
    });
  });
});

describe('topology (DPL-002)', () => {
  test('separate is the default', () => {
    const { graph } = buildGraph(base);

    expect(graph.topology).toBe('separate');
    expect(graph.units.map((unit) => unit.name)).toEqual(['admin', 'http']);
    expect(graph.merged).toEqual([]);
  });

  test('single merges everything but the migrations, and reports what it merged', () => {
    const { graph } = buildGraph(
      {
        ...base,
        connections: [{ name: 'primary', journal: true }],
      },
      { topology: 'single' },
    );

    expect(graph.topology).toBe('single');
    expect(graph.units.map((unit) => unit.name)).toEqual(['app', 'migrate:primary']);
    expect(graph.merged).toEqual(['admin', 'http']);

    const app = graph.units.find((unit) => unit.name === 'app');
    // One public route makes the merged unit public: `single` cannot keep `admin` private.
    expect(app?.private).toBe(false);
    expect(app?.triggers).toEqual([
      { kind: 'http', detail: ['GET /api/orders', 'GET /health', 'POST /api/orders'] },
    ]);
  });

  test('single keeps the union of bindings, deduplicated by name', () => {
    const resolution = applyTopology(
      resolveUnits({
        appName: 'acme',
        deploy: {
          units: [
            { name: 'a', kind: 'http', bindings: [{ kind: 'kv', name: 'CACHE' }] },
            {
              name: 'b',
              kind: 'queue',
              bindings: [
                { kind: 'kv', name: 'CACHE' },
                { kind: 'queue', name: 'JOBS' },
              ],
            },
          ],
        },
      }),
      'single',
    );

    expect(resolution.units[0]?.bindings.map((binding) => binding.name)).toEqual(['CACHE', 'JOBS']);
    expect(resolution.merged).toEqual(['a', 'b']);
  });

  test('an unknown topology is a config error, not a silent default', () => {
    expect(() => buildGraph(base, { topology: 'cluster' as unknown as 'single' })).toThrow(
      /topology must be/,
    );
  });
});

describe('validation (DPL-003, DPL-006)', () => {
  test('a capacity the target lacks is reported with the matrix row', () => {
    const { graph, problems } = buildGraph(
      {
        appName: 'acme',
        routes: [{ method: 'GET', path: '/feed', module: 'feed' }],
        modules: [{ name: 'feed', requires: ['raw-sockets'] }],
      },
      { targets: [{ target: 'cloudflare' }] },
    );

    expect(graph.units).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ unit: 'http', code: 'DPL_CAPABILITY_MISSING' });
    expect(problems[0]?.message).toContain('raw-sockets');
    expect(problems[0]?.message).toContain('cloudflare');
  });

  test('the same unit builds for a target that has the capability', () => {
    const { problems } = buildGraph(
      {
        appName: 'acme',
        routes: [{ method: 'GET', path: '/feed', module: 'feed' }],
        modules: [{ name: 'feed', requires: ['raw-sockets'] }],
      },
      { targets: [{ target: 'bun' }, { target: 'cloudflare' }] },
    );

    // Only the Workers target complains; `bun` has sockets.
    expect(problems.map((problem) => problem.message)).toHaveLength(1);
    expect(problems[0]?.message).toContain('cloudflare');
  });

  test('a binding the target never declared fails, and a declared one does not', () => {
    const input: DeploymentInput = {
      appName: 'acme',
      routes: [{ method: 'GET', path: '/', module: 'db' }],
      modules: [{ name: 'db', bindings: [{ kind: 'hyperdrive', name: 'HYPERDRIVE' }] }],
    };

    const missing = buildGraph(input, { targets: [{ target: 'cloudflare' }] });
    expect(missing.problems.map((problem) => problem.code)).toEqual(['DPL_BINDING_MISSING']);

    const declared = buildGraph(input, {
      targets: [
        { target: 'cloudflare', bindings: { HYPERDRIVE: { kind: 'hyperdrive', resource: 'pg' } } },
      ],
    });
    expect(declared.problems).toEqual([]);
  });

  test('a secret is not a target binding, so its absence is not an error', () => {
    const { problems } = buildGraph(
      {
        appName: 'acme',
        deploy: {
          units: [{ name: 'http', kind: 'http', bindings: [{ kind: 'secret', name: 'APP_KEY' }] }],
        },
      },
      { targets: [{ target: 'lambda' }] },
    );

    expect(problems).toEqual([]);
  });

  test('two units claiming the same route fail together', () => {
    const graph: UnitGraph = {
      schemaVersion: 1,
      app: 'acme',
      topology: 'separate',
      merged: [],
      targets: [],
      units: [
        {
          name: 'http',
          kind: 'http',
          modules: [],
          reasons: [],
          triggers: [{ kind: 'http', detail: ['GET /api/orders'] }],
          requires: [],
          bindings: [],
          private: false,
        },
        {
          name: 'admin',
          kind: 'admin',
          modules: [],
          reasons: [],
          triggers: [{ kind: 'http', detail: ['GET /api/orders'] }],
          requires: [],
          bindings: [],
          private: true,
        },
      ],
    };

    const problems = checkGraph(graph, {});
    expect(problems.map((problem) => problem.code)).toEqual(['DPL_DUPLICATE_ROUTE']);
    expect(problems[0]?.message).toContain('GET /api/orders');
    expect(problems[0]?.message).toContain('http and admin');
  });
});

describe('cron triggers (§ 4.6)', () => {
  const withSchedule = (cron: string): DeploymentInput => ({
    appName: 'acme',
    schedules: [{ name: 'nightly', cron }],
  });

  test('a valid cron is a schedule unit with a cron trigger', () => {
    const { graph, problems } = buildGraph(withSchedule('0 3 * * *'), {
      targets: [{ target: 'cloudflare' }],
    });

    expect(problems).toEqual([]);
    const unit = graph.units.find((candidate) => candidate.name === 'schedule');
    expect(unit?.triggers).toEqual([{ kind: 'cron', detail: ['0 3 * * *'] }]);
  });

  test('a cron the platform would read differently is a build problem', () => {
    // `deploy.units` in `tsir.js` can carry any string, and this one means OR to a Worker and
    // "Mondays" to EventBridge. The graph refuses it before either is emitted.
    const { problems } = buildGraph(withSchedule('0 0 1 * 1'), {
      targets: [{ target: 'cloudflare' }],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('DPL_CRON_INVALID');
    expect(problems[0]?.message).toContain('unit "schedule"');
    expect(problems[0]?.message).toContain('both restricted');
  });

  test('a task declared in a local hour is emitted as the UTC cron it means', () => {
    // `0 3 * * *` at UTC+8 is 19:00 UTC — the previous day, which is the same instant for a
    // cron that fires every day. The trigger shows the platform's expression; `--explain` shows
    // both, so nobody has to redo the arithmetic at 3 AM.
    const { graph, problems } = buildGraph(
      {
        appName: 'acme',
        schedules: [{ name: 'report', cron: '0 3 * * *', utcOffsetMinutes: 480 }],
      },
      { targets: [{ target: 'lambda' }] },
    );

    expect(problems).toEqual([]);
    expect(graph.units.find((unit) => unit.name === 'schedule')?.triggers).toEqual([
      { kind: 'cron', detail: ['0 19 * * *'] },
    ]);
    expect(explainGraph(graph)).toContain('0 3 * * * at 480 → 0 19 * * *');
  });

  test('a local hour a platform cron cannot express is refused, not shifted', () => {
    // The 1st in Manila is the last day of the previous month in UTC. EventBridge has no way to
    // say that, and firing on the wrong day is a worse outcome than a red build.
    const { problems } = buildGraph(
      {
        appName: 'acme',
        schedules: [{ name: 'billing', cron: '0 3 1 * *', utcOffsetMinutes: 480 }],
      },
      { targets: [{ target: 'lambda' }] },
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('DPL_CRON_NOT_UTC');
    expect(problems[0]?.message).toContain('utcOffsetMinutes 480');
    expect(problems[0]?.hint).toContain('fire cron triggers in UTC');
  });

  test('a malformed cron is a build problem, not a wrangler.toml Cloudflare rejects later', () => {
    const { problems } = buildGraph(withSchedule('0 0 * *'), { targets: [{ target: 'lambda' }] });

    expect(problems[0]?.code).toBe('DPL_CRON_INVALID');
    expect(problems[0]?.message).toContain('4 field(s); a cron has 5');
  });
});

describe('serialization and drift (DPL-004)', () => {
  test('the same input serializes byte-identically', () => {
    const a = serializeGraph(buildGraph(base).graph);
    const b = serializeGraph(buildGraph(base).graph);
    expect(a).toBe(b);
    expect(a.endsWith('}\n')).toBe(true);
  });

  test('reordering the input does not change the output', () => {
    const forwards = buildGraph({
      ...base,
      routes: [
        { method: 'GET', path: '/a', module: 'orders' },
        { method: 'POST', path: '/b', module: 'orders' },
      ],
    }).graph;
    const backwards = buildGraph({
      ...base,
      routes: [
        { method: 'POST', path: '/b', module: 'orders' },
        { method: 'GET', path: '/a', module: 'orders' },
      ],
    }).graph;

    expect(serializeGraph(forwards)).toBe(serializeGraph(backwards));
  });

  test('a committed snapshot round-trips, and a bad one is a config error', () => {
    const text = serializeGraph(buildGraph(base).graph);
    expect(serializeGraph(parseGraph(text))).toBe(text);

    expect(() => parseGraph('{')).toThrow(TsirError);
    expect(() => parseGraph('{"schemaVersion":99,"units":[]}')).toThrow(/schemaVersion/);
  });

  test('drift names the unit and the field that changed', () => {
    const before = buildGraph(base).graph;
    const after = buildGraph({
      ...base,
      routes: [
        ...(base.routes ?? []).filter((route) => route.path !== '/health'),
        { method: 'GET', path: '/health', module: 'orders' },
      ],
    }).graph;

    const diff = diffGraphs(before, after);

    expect(diff.empty).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(['admin']);
    expect(describeDiff(diff)).toContain('- unit admin');
    expect(describeDiff(diff)).toContain('~ http.triggers');
  });

  test('an identical graph has no drift', () => {
    const graph = buildGraph(base).graph;
    expect(diffGraphs(graph, graph).empty).toBe(true);
    expect(describeDiff(diffGraphs(graph, graph))).toContain('no drift');
  });

  test('a topology change is drift too', () => {
    const before = buildGraph(base).graph;
    const after = buildGraph(base, { topology: 'single' }).graph;

    expect(diffGraphs(before, after).changed[0]).toMatchObject({
      unit: '(graph)',
      field: 'topology',
      before: 'separate',
      after: 'single',
    });
  });
});

describe('output (DPL-005)', () => {
  test('the plan prints one row per unit and the problems underneath', () => {
    const { graph, problems } = buildGraph(
      {
        appName: 'acme',
        routes: [{ method: 'GET', path: '/feed', module: 'feed' }],
        modules: [{ name: 'feed', requires: ['raw-sockets'] }],
      },
      { targets: [{ target: 'cloudflare' }] },
    );

    const text = formatGraph(graph, problems);
    expect(text).toContain('unit');
    expect(text).toContain('http');
    expect(text).toContain('✗ DPL_CAPABILITY_MISSING');
    expect(text).toContain('1 unit(s) · topology separate');
  });

  test('--explain prints the declaration behind every unit', () => {
    const text = explainGraph(buildGraph(base).graph);

    expect(text).toContain('admin (admin, private)');
    expect(text).toContain('routes: GET /health');
    expect(text).toContain('http (http)');
  });

  test('--json is one document with the graph and the problems', () => {
    const { graph, problems } = buildGraph(base);
    const parsed = JSON.parse(graphJson(graph, problems)) as {
      app: string;
      units: { name: string }[];
      problems: unknown[];
    };

    expect(parsed.app).toBe('acme');
    expect(parsed.units.map((unit) => unit.name)).toEqual(['admin', 'http']);
    expect(parsed.problems).toEqual([]);
  });

  test('an unconfigured target lists the ones that exist', () => {
    let thrown: unknown;
    try {
      assertTarget([{ target: 'bun' }], 'lambda');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TsirError);
    const error = thrown as TsirError;
    expect(error.message).toContain('"lambda" is not configured');
    expect(error.hint).toContain('configured targets: bun');
  });
});

describe('edge cases that used to be untested', () => {
  test('an override may pull modules, capabilities and bindings from the module map', () => {
    const units = resolveUnits({
      appName: 'acme',
      modules: [
        {
          name: 'workers',
          requires: ['background-tasks'],
          bindings: [{ kind: 'queue', name: 'JOBS' }],
        },
      ],
      deploy: { units: [{ name: 'jobs', kind: 'queue', modules: ['workers'], private: false }] },
    });

    expect(units[0]).toMatchObject({
      name: 'jobs',
      requires: ['background-tasks'],
      modules: ['workers'],
      private: false,
    });
    expect(units[0]?.bindings.map((binding) => binding.name)).toEqual(['JOBS']);
  });

  test('deploy.units memoryMb and timeoutSeconds flow to the unit (DPL-031)', () => {
    const units = resolveUnits({
      appName: 'acme',
      modules: [{ name: 'jobs', requires: ['background-tasks'] }],
      deploy: {
        units: [
          { name: 'jobs', kind: 'queue', modules: ['jobs'], memoryMb: 2048, timeoutSeconds: 120 },
        ],
      },
    });

    expect(units.at(0)).toMatchObject({
      name: 'jobs',
      memoryMb: 2048,
      timeoutSeconds: 120,
    });
  });

  test('includeModules names the module itself as the unit, and ignores unknown names', () => {
    const units = resolveUnits({
      appName: 'acme',
      modules: [{ name: 'reports', requires: ['filesystem'] }],
      deploy: { includeModules: ['reports', 'ghost'] },
    });

    expect(units.map((unit) => unit.name)).toEqual(['reports']);
    expect(units[0]?.reasons).toEqual([
      { source: 'override', from: 'deploy.includeModules.reports' },
    ]);
  });

  test('single topology with only migrations merges nothing', () => {
    const resolution = applyTopology(
      resolveUnits({ appName: 'acme', connections: [{ name: 'primary', journal: true }] }),
      'single',
    );

    expect(resolution.units.map((unit) => unit.name)).toEqual(['migrate:primary']);
    expect(resolution.merged).toEqual([]);
  });

  test('a snapshot that is not an object, or has no units, is refused', () => {
    expect(() => parseGraph('[]')).toThrow(/must contain an object/);
    expect(() => parseGraph('{"schemaVersion":1}')).toThrow(/no units array/);
  });

  test('an empty graph prints as empty, and explain says so too', () => {
    const { graph } = buildGraph({ appName: 'acme' });

    expect(formatGraph(graph)).toContain('no units');
    expect(explainGraph(graph)).toContain('no units');
    expect(graphJson(graph, [])).toContain('"units": []');
  });

  test('a problem prints under the graph with its hint', () => {
    const { graph, problems } = buildGraph(
      {
        appName: 'acme',
        routes: [{ method: 'GET', path: '/x', module: 'feed' }],
        modules: [{ name: 'feed', requires: ['raw-sockets'] }],
      },
      { targets: [{ target: 'cloudflare' }] },
    );

    const text = formatGraph(graph, problems);
    expect(text).toContain('✗ DPL_CAPABILITY_MISSING');
    expect(text).toContain('drop the module from this unit');
  });

  test('an explain block shows requires and bindings when a unit has them', () => {
    const { graph } = buildGraph({
      appName: 'acme',
      deploy: {
        units: [
          {
            name: 'jobs',
            kind: 'queue',
            requires: ['background-tasks'],
            bindings: [{ kind: 'queue', name: 'JOBS' }],
          },
        ],
      },
    });

    const text = explainGraph(graph);
    expect(text).toContain('requires: background-tasks');
    expect(text).toContain('bindings: JOBS (queue)');
  });

  test('every deploy error code is constructible and names the fix', async () => {
    const { envLimit, graphDrift, secretLeak, sizeBudget, unitEmpty, invalidDeployConfig } =
      await import('./errors.ts');

    expect(sizeBudget({ unit: 'http', bytes: 2_000_000, budget: 1_000_000 }).code).toBe(
      'DPL_SIZE_BUDGET',
    );
    expect(graphDrift('unit-graph.json', 'one unit').code).toBe('DPL_GRAPH_DRIFT');
    expect(secretLeak({ file: 'index.js', pattern: 'APP_KEY' }).code).toBe('DPL_SECRET_LEAK');
    expect(unitEmpty('queue', 'declare a handler').hint).toBe('declare a handler');
    expect(envLimit({ target: 'lambda', count: 3, bytes: 10, maxCount: 1, maxBytes: 5 }).code).toBe(
      'DPL_ENV_LIMIT',
    );
    expect(invalidDeployConfig('bad topology').hint).toContain('tsir.js');
  });
});

describe('internal publish and invoke validation (DPL-030)', () => {
  const input: DeploymentInput = {
    appName: 'acme',
    listeners: [
      { kind: 'sns', name: 'orders', unit: 'sns' },
      { kind: 'steptask', name: 'process-refund', unit: 'admin' },
    ],
    modules: [{ name: 'orders', requires: [] }],
    deploy: {
      publishes: ['orders', 'ghost-topic'],
      invokes: [
        { unit: 'admin', task: 'process-refund' },
        { unit: 'admin', task: 'nonexistent' },
      ],
    },
  };

  test('a publish to a declared topic passes; an undeclared topic fails', () => {
    const { problems } = buildGraph(input);
    const publishProblems = problems.filter((p) => p.code === 'DPL_PUBLISH_UNKNOWN');
    expect(publishProblems.map((p) => p.message)).toContain(
      'no @OnSns listener for topic "ghost-topic"',
    );
    // 'orders' is declared, so it must not appear.
    expect(publishProblems.map((p) => p.message)).not.toContain('"orders"');
  });

  test('an invoke to a declared task passes; an undeclared task fails', () => {
    const { problems } = buildGraph(input);
    const invokeProblems = problems.filter((p) => p.code === 'DPL_INVOKE_UNKNOWN');
    expect(invokeProblems.map((p) => p.message)).toContain(
      'no @OnStepTask listener for task "nonexistent" in unit "admin"',
    );
  });
});
