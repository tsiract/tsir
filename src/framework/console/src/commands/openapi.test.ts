/**
 * `tsir openapi:generate` (DXS-011): the document of the compiled route table, written to a file.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { openapiGenerateCommand } from './openapi.ts';

const HTTP_EXAMPLE = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'examples', 'http');

describe('openapi:generate (DXS-011)', () => {
  let scratch = '';
  let previous = '';

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'tsir-openapi-'));
    previous = process.cwd();
    process.chdir(HTTP_EXAMPLE);
  });

  afterEach(() => {
    process.chdir(previous);
    rmSync(scratch, { recursive: true, force: true });
  });

  test('writes an OpenAPI 3.1 document with one operation per compiled route', async () => {
    const file = join(scratch, 'openapi.json');
    // A subprocess, as the real CLI runs: the route registry is process-wide, and other suites in
    // this process register routes of their own.
    const run = spawnSync(
      process.execPath,
      [join(import.meta.dir, '..', 'cli.ts'), 'openapi:generate', '--out', file],
      { cwd: HTTP_EXAMPLE, encoding: 'utf8' },
    );
    expect(run.status).toBe(EXIT.ok);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('http-example');
    // The example has six routes over four paths (`route:list` prints the same six).
    const operations = Object.values(doc.paths).reduce(
      (count, item) => count + Object.keys(item).length,
      0,
    );
    expect(operations).toBe(6);
    expect(Object.keys(doc.paths)).toContain('/api/users/{id}');
  });

  test('a project that cannot be loaded is reported, not written', async () => {
    process.chdir(scratch);
    expect(await openapiGenerateCommand(['--out', join(scratch, 'x.json')])).not.toBe(EXIT.ok);
  });
});
