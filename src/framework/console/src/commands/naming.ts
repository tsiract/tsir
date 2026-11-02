/**
 * Name helpers shared by the generators (`make:*`).
 *
 * `SendReceipt` becomes `send-receipt`, which is the stem of the file and the default name of the
 * job or listener. Only ASCII letters and digits are accepted, so the stem is always a valid
 * module path and a valid job name.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT, UsageError } from '../output.ts';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

/** `OrderPlaced` → `order-placed`; `blog_post` → `blog-post`. */
export function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** True when the value is a PascalCase-able identifier (letters and digits, starting with a letter). */
export function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

/** Strict, filesystem-safe names for module-scoped generators. */
export function scopedName(
  input: string,
  kind: string,
): { stem: string; pascal: string; camel: string } {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(input)) {
    throw new UsageError(
      `"${input}" is not a valid ${kind} name`,
      'use kebab-case, e.g. user-settings',
    );
  }
  const stem = toKebab(input);
  const pascal = stem
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  if (
    /^(?:await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield)$/.test(
      camel,
    )
  ) {
    throw new UsageError(
      `"${input}" is a reserved name`,
      'choose a name that is not a TypeScript keyword',
    );
  }
  if (kind === 'module' && camel === 'registry') {
    throw new UsageError(
      'registry is reserved for the module route registry',
      'choose a different module name',
    );
  }
  return { stem, pascal, camel };
}

/**
 * Splits a `make:*` module target that may be qualified with an app directory.
 *
 * `shop` → `{ app: undefined, module: 'shop' }`
 * `todo-app/shop` → `{ app: 'todo-app', module: 'shop' }`
 *
 * The caller is responsible for `process.chdir(app)` when `app` is defined, so
 * the rest of the generator can keep using `process.cwd()` as the app root.
 *
 * Both parts must be plain names: no `..`, no extra slashes, no absolute paths.
 * This keeps every generator inside the project tree.
 */
export function splitAppModule(input: string): { app: string | undefined; module: string } {
  const slash = input.indexOf('/');
  if (slash === -1) return { app: undefined, module: input };
  const app = input.slice(0, slash);
  const module = input.slice(slash + 1);
  if (app === '' || app === '.' || app === '..' || app.includes('/') || app.includes('\\')) {
    throw new UsageError(
      `"${input}" is not a valid app/module target`,
      'use a plain app name, e.g. todo-app/shop',
    );
  }
  if (module.includes('/') || module.includes('\\')) {
    throw new UsageError(
      `"${input}" is not a valid app/module target`,
      'use a single module name, e.g. todo-app/shop',
    );
  }
  return { app, module };
}

/** Module-scoped generators do not create a missing or incomplete module implicitly. */
export function requireModule(input: string, root = process.cwd()): { name: string; dir: string } {
  const name = scopedName(input, 'module').stem;
  const dir = join(root, name);
  const routes = join(dir, 'routes.ts');
  const index = join(dir, 'index.ts');
  if (!existsSync(dir)) {
    throw new CliError(
      `module ${name} does not exist`,
      EXIT.failure,
      `run tsir make:module ${name} first`,
    );
  }
  if (
    !statSync(dir).isDirectory() ||
    !existsSync(routes) ||
    !existsSync(index) ||
    !statSync(routes).isFile() ||
    !statSync(index).isFile()
  ) {
    throw new CliError(
      `module ${name} is incomplete: expected index.ts and routes.ts`,
      EXIT.failure,
      'repair the module before generating its files; nothing was written',
    );
  }
  return { name, dir };
}
