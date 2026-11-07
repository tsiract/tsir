/**
 * The third-party dependency policy as data (ADR-0012, amended by ADR-0022).
 *
 * Kept in its own module so the two things that must agree — `check-deps` (which
 * enforces it) and `readme-badges` (which publishes the count) — read the same list
 * instead of each counting manifests their own way.
 */

export interface Policy {
  readonly rationale: string;
  readonly phase: string;
  /** Expected tree-shaking evidence, recorded so a reviewer can re-verify it. */
  readonly shaking: string;
  /**
   * The dependency ships CommonJS or has no `sideEffects` declaration, and that is
   * accepted **only** because it is scoped to a Node-only adapter (`ADR-0022 § 2`).
   * Declaring this switches the ESM/purity failures into recorded notes; the scope
   * requirement stays, so it can never become a root dependency by accident.
   */
  readonly nodeOnly?: { readonly why: string } | undefined;
  /**
   * Subpath entrypoints allowed to import this dependency (`ADR-0022`), e.g.
   * `['@tsir/link/grpc']`. Absent means "the root entrypoint may reach it", which is
   * the default and the expensive one. When present, the import graph proves the root
   * closure never mentions it.
   */
  readonly scope?: readonly string[];
}

/** Runtime dependencies a consumer's bundle can end up containing. */
export const RUNTIME_ALLOWLIST: Readonly<Record<string, Policy>> = {
  zod: {
    rationale:
      'Schema validation. The de-facto standard in the TypeScript ecosystem and the author of ' +
      'Standard Schema; @tsir/validate is built on top of it rather than re-implementing validation.',
    phase: 'P1',
    shaking:
      'ESM with per-entry subpaths (zod/mini, zod/v4/core); sideEffects lists only ./compile.js',
  },
  '@bufbuild/protobuf': {
    rationale:
      'Protobuf runtime for the gRPC adapter. Chosen over protobufjs because `protoc-gen-es` ' +
      'emits plain ESM that imports it per-symbol, and it is the runtime Buf maintains for its own generator.',
    phase: 'P5',
    shaking: 'ESM with subpath exports (@bufbuild/protobuf/codegenv2); sideEffects: false',
    scope: ['@tsir/link/grpc'],
  },
  '@grpc/grpc-js': {
    rationale:
      'The gRPC transport (HTTP/2, HPACK, status handling) on Node and Bun. Pure JavaScript so it ' +
      'needs no native build; CommonJS, which is why it is a Node-only, subpath-scoped adapter dependency.',
    phase: 'P5',
    shaking:
      'CommonJS; bundled only into Node/Lambda targets and never reachable from @tsir/link root',
    scope: ['@tsir/link/grpc'],
    nodeOnly: {
      why: 'grpc-js is CJS-only and needs node:http2; it can never run in a Workers bundle, so it is never bundled for one',
    },
  },
  'drizzle-orm': {
    rationale:
      'SQL query builder and migrations. Chosen over a bespoke query layer in ADR-0007; ' +
      'per-dialect entry points keep unused drivers out of the bundle.',
    phase: 'P3',
    shaking: 'ESM per dialect (`drizzle-orm/postgres-js` etc.); sideEffects: false',
  },
  postgres: {
    rationale:
      'Postgres driver for long-running targets (Bun, Lambda). Streaming-capable and dependency-free.',
    phase: 'P3',
    shaking: 'Pure ESM/CJS with no side-effectful imports; only loaded by @tsir/database/postgres',
  },
};

/** Build-time only. Recorded for auditability, not size-gated. */
/**
 * Build-time-only dependencies, each with the reason it cannot reach a consumer's
 * bundle. A dependency that ships at runtime does not belong here — that is what
 * `RUNTIME_ALLOWLIST` is for.
 */
export const DEV_ONLY: Readonly<Record<string, string>> = {
  daisyui:
    'CSS component source and Nord/Abyss themes; compiled into the static frontpage, never shipped as a framework dependency (ADR-0029)',
  tailwindcss: 'build-time CSS compiler for the frontpage; no runtime import (ADR-0029)',
  '@tailwindcss/cli': 'build-time CLI that compiles only the frontpage styles (ADR-0029)',
  marked: 'Markdown renderer for the static docs site; build time only (ADR-0028)',
  typescript: 'compiler; never imported by shipped code',
  'typescript-eslint': 'lint rules; build time only',
  eslint: 'lint runner; build time only',
  prettier: 'formatter; build time only',
  '@types/bun': 'ambient types for `bun test`; erased at build',
  '@types/node': 'ambient types for Node built-ins used by tools; erased at build',
  '@bufbuild/protoc-gen-es':
    'code generator; invoked by buf at build time and never imported by shipped code',
  postgres:
    'the Postgres *client* is supplied by the application (ADR-0009); installed here only so ' +
    'type-tests/ can prove the real client satisfies the driver’s structural type',
  playwright:
    'browser backend for @tsir/nightwatch; an application installs it only when running e2e tests, never as a runtime dependency',
  sharp:
    'native image transform for the @tsir/media sharp adapter; an optional peer dependency the application opts into, installed here only for adapter tests',
};
