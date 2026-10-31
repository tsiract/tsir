/**
 * Type-level tests for configuration inference.
 *
 * The important guarantee: a field declared with `env.secret()` is typed as
 * `Redacted<string>`, so logging it without `reveal()` is a compile error at
 * the call site — redaction is a type, not a convention.
 */

import { defineConfig, env, type InferConfig, type Redacted } from '../src/index.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  DATABASE_URL: env.secret(),
  ALGOLIA_KEY: env.secret({ minLength: 16 }),
  POOL_MAX: env.int({ min: 1, max: 50, default: 10 }),
  FEATURE: env.bool({ default: false }),
});

type Config = InferConfig<typeof spec>;

declare const config: Config;

// ── widened to the declared types ──────────────────────────────────────────

const envName: 'development' | 'test' | 'production' = config.APP_ENV;
const poolMax: number = config.POOL_MAX;
const feature: boolean = config.FEATURE;
void envName;
void poolMax;
void feature;

// ── secrets are Redacted, not string ───────────────────────────────────────

const secret: Redacted<string> = config.DATABASE_URL;
void secret;

// @ts-expect-error — a secret may not be used as a plain string
const leaked: string = config.DATABASE_URL;
void leaked;

// Template interpolation is *allowed by the type system* but masked at runtime
// (Redacted.toString/Symbol.toPrimitive). This is the fail-safe half of the
// redaction model: the type stops assignments, the value stops interpolation.
// eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- deliberate: see below
const interpolated = `dsn=${config.DATABASE_URL}`;
const interpolatedType: string = interpolated;
void interpolatedType;

// reveal() yields the underlying value on purpose
const revealed: string = config.DATABASE_URL.reveal();
void revealed;

// ── numeric fields are numbers, never numeric strings ──────────────────────

// @ts-expect-error — POOL_MAX is a number
const asString: string = config.POOL_MAX;
void asString;
