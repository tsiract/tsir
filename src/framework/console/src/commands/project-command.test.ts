import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMANDS, runProjectCommand } from '../index.ts';
import { defineCommand, registerCommands } from '../define-command.ts';
import { EXIT, UsageError } from '../output.ts';
import { commandTemplate, makeCommandCommand } from './make-command.ts';
import {
  notListedMessage,
  projectCommandsOf,
  RACT_MODE,
  RACT_TEMPLATE,
  unknownConsoleCommands,
} from './project-command.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'ract-app');

describe('ract template (CLI-018)', () => {
  test('starts with the bun shebang and has no type annotations', () => {
    expect(RACT_TEMPLATE.startsWith('#!/usr/bin/env bun\n')).toBe(true);
    expect(RACT_TEMPLATE).not.toContain(': string');
    expect(RACT_TEMPLATE).toContain("from '@tsir/console'");
    expect(RACT_TEMPLATE).toContain('runProjectCommand(process.argv.slice(2))');
  });

  test('the mode is 0755', () => {
    expect(RACT_MODE).toBe(0o755);
  });
});

describe('console.commands allow-list (CLI-020)', () => {
  test('a listed name that the framework does not know is reported', () => {
    expect(unknownConsoleCommands(['doctor', 'pnig'], ['doctor', 'make:job'])).toEqual(['pnig']);
  });

  test('a refusal names the key to edit', () => {
    expect(notListedMessage('make:job')).toEqual({
      message: '"make:job" is not listed in console.commands',
      hint: 'add "make:job" to console.commands in tsir.js',
    });
  });

  test('ract refuses a framework command the project did not list', async () => {
    expect(await runProjectCommand(['make:job', 'X'], FIXTURE)).toBe(EXIT.usage);
  });

  test('ract runs a listed or meta command', async () => {
    expect(await runProjectCommand(['help'], FIXTURE)).toBe(EXIT.ok);
  });
});

describe('make:command (CLI-019)', () => {
  let root = '';
  let previous = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tsir-command-'));
    previous = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  });

  test('tsir make:command Ping scaffolds a command that names the next step', async () => {
    expect(await makeCommandCommand(['Ping'])).toBe(EXIT.ok);
    const file = readFileSync(join(root, 'console', 'ping.command.ts'), 'utf8');
    expect(file).toBe(commandTemplate('ping'));
    expect(file).toContain("name: 'ping'");
    expect(file).toContain('bun ract ping');
    expect(file).toContain("from '@tsir/console'");
  });
});

describe('project commands from the entry (CLI-019)', () => {
  test('ract runs a project command the entry exports and console.commands lists', async () => {
    expect(await runProjectCommand(['ping', 'a'], FIXTURE)).toBe(EXIT.ok);
  });

  test('ract refuses a project command that console.commands does not list', async () => {
    expect(await runProjectCommand(['secret'], FIXTURE)).toBe(EXIT.usage);
  });

  test('the commands export is an array of defineCommand values', () => {
    expect(projectCommandsOf({})).toEqual([]);
    expect(() => projectCommandsOf({ commands: 'ping' })).toThrow(UsageError);
    expect(() => projectCommandsOf({ commands: [{ name: 'ping' }] })).toThrow(UsageError);
    expect(() =>
      projectCommandsOf({
        commands: [{ name: 'Bad Name', summary: 's', run: () => Promise.resolve(0) }],
      }),
    ).toThrow(UsageError);
  });

  test('a project command may not reuse a framework name', () => {
    const clash = defineCommand({ name: 'doctor', summary: 'x', run: () => Promise.resolve(0) });
    expect(() => registerCommands([...COMMANDS, clash])).toThrow(UsageError);
  });
});
