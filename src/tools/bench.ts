/**
 * Benchmark harness (FND-019).
 *
 * The project's rules say performance claims need evidence. A micro-benchmark is
 * not a product benchmark, but it does catch the two regressions that matter at
 * this stage: a hot path gaining an allocation it does not need, and the route
 * matcher degrading from constant-ish to linear.
 *
 *   bun src/tools/bench.ts            # measure, write bench/latest.json, compare
 *   bun src/tools/bench.ts --write    # also update bench/baseline.json
 *
 * Methodology: warm up, then run enough iterations that the measurement is not
 * dominated by the timer. Results are reported as nanoseconds per operation and
 * compared to the committed baseline with a generous 2× tolerance — CI machines
 * are noisy, and a benchmark that fails on noise trains people to ignore it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Controller, compileRoutes, Get, RouteRegistry } from '../framework/router/src/index.ts';
import { createMatcher } from '../framework/router/src/matcher.ts';
import { defineConfig, env, loadConfig } from '../framework/config/src/index.ts';
import { Container, token, valueProvider } from '../framework/container/src/index.ts';
import { defineModule } from '../framework/core/src/module.ts';
import { createManifest } from '../framework/core/src/manifest.ts';

export interface Measurement {
  readonly name: string;
  readonly nsPerOp: number;
  readonly opsPerSecond: number;
}

const DIR = join(process.cwd(), 'bench');
const BASELINE = join(DIR, 'baseline.json');
const LATEST = join(DIR, 'latest.json');

/** Runs `operation` until it has taken at least `minMs`, returning ns/op. */
export function measure(name: string, operation: () => void, minMs = 120): Measurement {
  for (let i = 0; i < 1000; i += 1) operation(); // warm-up

  let iterations = 0;
  const start = Bun.nanoseconds();
  let elapsedNs = 0;
  while (elapsedNs < minMs * 1e6) {
    operation();
    iterations += 1;
    elapsedNs = Bun.nanoseconds() - start;
  }

  const nsPerOp = elapsedNs / iterations;
  return { name, nsPerOp, opsPerSecond: 1e9 / nsPerOp };
}

function fixtureRoutes(count: number) {
  const registry = new RouteRegistry();
  for (let i = 0; i < count; i += 1) {
    const path = `/api/resource${String(i)}` as const;
    @Controller(registry, path)
    // declared for its decorator side effect
    class Controller_ {
      @Get('/')
      read(): unknown {
        return null;
      }

      @Get('/:id')
      readOne(): unknown {
        return null;
      }
    }
    void Controller_;
  }
  return registry;
}

const registry = fixtureRoutes(15);
const table = compileRoutes(registry.entries());
const matcher = createMatcher(table);
const request =
  table.routes.find((route) => route.path.endsWith('/:id'))?.path ?? '/api/resource7/42';
const concrete = request.replace(':id', '42');

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  SERVICE_NAME: env.string({ default: 'bench' }),
  PORT: env.int({ default: 3000 }),
  REGION: env.string({ default: 'local' }),
});
const envRecord = { SERVICE_NAME: 'bench' } as const;

const Greeter = token<{ greet(): string }>('Greeter');
const box = new Container();
box.register(valueProvider(Greeter, { greet: () => 'hi' }));

export const benchmarks: readonly Measurement[] = [
  measure('router: match a parameterised path (30 routes)', () => {
    matcher.match('GET', concrete);
  }),
  measure('router: compile 30 routes', () => {
    compileRoutes(registry.entries());
  }),
  measure('config: load and validate 4 fields', () => {
    loadConfig(spec, { env: envRecord });
  }),
  measure('container: resolve a singleton', () => {
    box.resolve(Greeter);
  }),
  measure('core: hash a module manifest', () => {
    createManifest('bench', [defineModule({ name: 'root' })], '2026-01-01T00:00:00.000Z');
  }),
];

if (import.meta.main) {
  const write = process.argv.includes('--write');
  mkdirSync(DIR, { recursive: true });

  const baseline: readonly Measurement[] = existsSync(BASELINE)
    ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as { benchmarks: Measurement[] }).benchmarks
    : [];
  const byName = new Map(baseline.map((entry) => [entry.name, entry]));

  const rows: string[] = [];
  const regressions: string[] = [];

  for (const result of benchmarks) {
    const before = byName.get(result.name);
    const ratio = before === undefined ? undefined : result.nsPerOp / before.nsPerOp;
    const flag = ratio === undefined ? '   new' : `${(ratio * 100).toFixed(0).padStart(5)} %`;
    rows.push(
      `  ${result.nsPerOp.toFixed(1).padStart(9)} ns/op  ${flag}  ${result.name}` +
        `  (${Math.round(result.opsPerSecond).toLocaleString('en-US')} ops/s)`,
    );
    if (ratio !== undefined && ratio > 2) {
      regressions.push(
        `${result.name}: ${result.nsPerOp.toFixed(1)} ns/op vs baseline ${before?.nsPerOp.toFixed(1)} (${(ratio * 100).toFixed(0)} %)`,
      );
    }
  }

  writeFileSync(
    LATEST,
    `${JSON.stringify(
      {
        runtime: `bun ${Bun.version}`,
        platform: `${process.platform}-${process.arch}`,
        generatedAt: new Date().toISOString(),
        benchmarks,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write('\n bench · ns/op vs baseline (2× tolerance)\n\n');
  process.stdout.write(`${rows.join('\n')}\n\n`);
  process.stdout.write('  written to bench/latest.json\n');

  if (write) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          runtime: `bun ${Bun.version}`,
          platform: `${process.platform}-${process.arch}`,
          benchmarks,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write('  ✓ baseline updated\n');
  }

  if (regressions.length > 0) {
    process.stderr.write(`\n slower than baseline by more than 2×:\n${regressions.join('\n')}\n`);
    process.exit(1);
  }
}
