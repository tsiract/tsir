/**
 * `tsir openapi:generate [--out file]` (DXS-011): the OpenAPI 3.1 document of the compiled route table.
 *
 * It reads the same table `route:list` prints, so the document and the routes cannot disagree. Without
 * `--out` the document goes to stdout; with it, the file is written and the operation count is printed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createOpenApiDocument } from '@tsir/http/openapi';
import { collectRouteEntries, compileRoutes } from '@tsir/router';

import { parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, ok } from '../output.ts';
import { loadProject } from '../project.ts';

/** The version the document declares: the project's package.json version, or 0.0.0 without one. */
async function projectVersion(root: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function openapiGenerateCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--out': { type: 'string', description: 'write the document to this file (default: stdout)' },
  });
  const out = stringFlag(args, '--out');

  let root: string;
  let title: string;
  try {
    const project = await loadProject(process.cwd());
    root = project.root;
    title = project.config.app.name;
  } catch (error: unknown) {
    return fail(error, false);
  }

  let document: ReturnType<typeof createOpenApiDocument>;
  let operations: number;
  try {
    const table = compileRoutes(collectRouteEntries());
    operations = table.routes.length;
    document = createOpenApiDocument(table, {
      title,
      version: await projectVersion(root),
    });
  } catch (error: unknown) {
    return fail(error, false);
  }

  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (out === undefined) {
    process.stdout.write(text);
    return EXIT.ok;
  }
  const target = resolve(process.cwd(), out);
  await writeFile(target, text);
  ok(`wrote ${out} (${String(operations)} operation(s), OpenAPI ${document.openapi})`);
  info(`  next: serve it or diff it against the last release`);
  return EXIT.ok;
}
