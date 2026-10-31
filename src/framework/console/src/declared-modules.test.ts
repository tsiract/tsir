/**
 * The top-level `modules` a project declares must be installed (`CFG-113`). The refusal names every
 * missing package and prints the exact `bun add` line.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { checkDeclaredModules } from './project.ts';
import { CliError } from './output.ts';

describe('declared modules (CFG-113)', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tsir-modules-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    // A minimal installed package, the way `bun install` lays one out.
    const pkg = join(root, 'node_modules', '@tsir', 'fake');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@tsir/fake', main: 'index.js' }),
    );
    writeFileSync(join(pkg, 'index.js'), 'export {};\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('installed modules pass', () => {
    expect(() => checkDeclaredModules(root, ['@tsir/fake'])).not.toThrow();
    expect(() => checkDeclaredModules(root, [])).not.toThrow();
  });

  test('a missing module is refused with the exact bun add line', () => {
    let caught: unknown;
    try {
      checkDeclaredModules(root, ['@tsir/fake', '@tsir/queue', '@tsir/events']);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const error = caught as CliError;
    expect(error.code).toBe('CFG_MODULE_NOT_INSTALLED');
    expect(error.message).toContain('@tsir/queue, @tsir/events');
    expect(error.hint).toBe('bun add @tsir/queue @tsir/events');
  });

  test('a module listed twice is reported once', () => {
    let caught: unknown;
    try {
      checkDeclaredModules(root, ['@tsir/queue', '@tsir/queue']);
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as CliError).hint).toBe('bun add @tsir/queue');
  });
});
