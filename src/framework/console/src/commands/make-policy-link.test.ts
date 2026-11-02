import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createCallContext } from '@tsir/link';

import { EXIT } from '../output.ts';
import { makeLinkClientCommand } from './make-link-client.ts';
import { makePolicyCommand } from './make-policy.ts';

// CLI-014. A policy file imports nothing, so its rule is called directly. A link client imports
// `@tsir/link` and `@tsir/link/rest`, which a scratch project cannot resolve, so the temp copy has
// those two specifiers rewritten to the repository's source before it is loaded. Nothing else
// changes, and the real REST client makes the calls against a fake `fetch`.

const LINK_SRC = resolve(import.meta.dir, '..', '..', '..', 'link', 'src');
const SPECIFIERS: Readonly<Record<string, string>> = {
  "'@tsir/link/rest'": `'${join(LINK_SRC, 'rest.ts')}'`,
  "'@tsir/link'": `'${join(LINK_SRC, 'index.ts')}'`,
};

let dir = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-policy-link-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

async function rejectionOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function linkToSource(): void {
  const walk = (folder: string): string[] =>
    readdirSync(folder).flatMap((entry) => {
      const path = join(folder, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  for (const file of walk(dir)) {
    if (!file.endsWith('.ts')) continue;
    let text = readFileSync(file, 'utf8');
    for (const [specifier, target] of Object.entries(SPECIFIERS)) {
      text = text.replaceAll(specifier, target);
    }
    writeFileSync(file, text);
  }
}

interface PolicyModule {
  readonly postUpdateRule: (context: {
    readonly principal: { readonly subject: string };
    readonly data: unknown;
    readonly permissions: ReadonlySet<string>;
  }) => { readonly allowed: boolean; readonly reason: string };
  readonly postUpdatePolicy: readonly [string, unknown];
}

describe('make:policy', () => {
  test('writes a rule with no imports, and the pair is keyed by resource:action', async () => {
    expect(await makePolicyCommand(['Post', 'update'])).toBe(EXIT.ok);
    const path = join(dir, 'policies', 'post-update.policy.ts');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/^import /m);
    expect(text).toContain("export const postUpdateRef = 'post:update';");
  });

  test('the rule grants what the role grants, and denies everything else (fail closed)', async () => {
    await makePolicyCommand(['Post', 'update']);
    const mod = (await import(
      join(dir, 'policies', 'post-update.policy.ts')
    )) as PolicyModule;

    const principal = { subject: 'user-1' };
    const granted = mod.postUpdateRule({
      principal,
      data: { authorId: 'user-2' },
      permissions: new Set(['post.update']),
    });
    expect(granted.allowed).toBe(true);

    const denied = mod.postUpdateRule({ principal, data: undefined, permissions: new Set() });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('post.update is not granted');
  });

  test('a kebab resource is a valid permission and gets a camelCase name', async () => {
    expect(await makePolicyCommand(['BlogPost', 'publish'])).toBe(EXIT.ok);
    const text = readFileSync(join(dir, 'policies', 'blog-post-publish.policy.ts'), 'utf8');
    expect(text).toContain("export const blogPostPublishRef = 'blog-post:publish';");
    expect(text).toContain("permissions.has('blog-post.publish')");
  });

  test('a name that is not a permission is refused, and a missing action is a usage error', async () => {
    expect(await rejectionOf(makePolicyCommand(['Post', 'Up!']))).toContain(
      'does not make a permission',
    );
    expect(await rejectionOf(makePolicyCommand(['Post']))).toContain(
      'needs a resource and an action',
    );
  });
});

describe('make:link-client', () => {
  test('writes a class whose options come through the constructor and whose path is typed', async () => {
    expect(await makeLinkClientCommand(['Billing'])).toBe(EXIT.ok);
    const text = readFileSync(join(dir, 'clients', 'billing.client.ts'), 'utf8');
    expect(text).toContain('export class BillingClient');
    expect(text).toContain('constructor(options: RestClientOptions)');
    expect(text).toContain('`/billing/${encodeURIComponent(id)}`');
  });

  test('--path sets the prefix, and a malformed prefix is refused', async () => {
    expect(await makeLinkClientCommand(['Billing', '--path', '/v2/invoices'])).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'clients', 'billing.client.ts'), 'utf8')).toContain(
      '`/v2/invoices/${encodeURIComponent(id)}`',
    );
    for (const bad of ['/', '/billing/', 'billing', '/a//b', '/x"y']) {
      expect(await rejectionOf(makeLinkClientCommand(['Other', '--path', bad]))).toContain(
        'not a usable path prefix',
      );
    }
  });

  test('the generated client makes a typed call through the real REST client', async () => {
    await makeLinkClientCommand(['Billing']);
    linkToSource();
    const { BillingClient } = (await import(join(dir, 'clients', 'billing.client.ts'))) as {
      BillingClient: new (options: Record<string, unknown>) => {
        get(
          ctx: ReturnType<typeof createCallContext>,
          id: string,
        ): Promise<{ ok: boolean; value?: { id: string } }>;
      };
    };

    const seen: string[] = [];
    const client = new BillingClient({
      baseUrl: 'https://billing.example.test',
      allowedHosts: ['billing.example.test'],
      deps: {
        fetch: async (url: string) => {
          seen.push(url);
          return new Response(JSON.stringify({ id: 'inv 1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        now: () => 0,
        sleep: async () => undefined,
        random: () => 0,
      },
    });

    const result = await client.get(createCallContext({}), 'inv 1');
    expect(result.ok).toBe(true);
    expect(result.value?.id).toBe('inv 1');
    expect(seen).toEqual(['https://billing.example.test/billing/inv%201']);
  });
});
