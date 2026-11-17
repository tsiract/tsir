import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAIMS, claimsIn, unclassified, unusedClaims } from './frontpage-claims.ts';

const PAGE = join(import.meta.dir, '..', 'apps', 'frontpage', 'public', 'index.html');
const real = readFileSync(PAGE, 'utf8');
const known = CLAIMS.map((claim) => claim.name);

describe('frontpage driver claims (DOCS-008)', () => {
  test('every product the page names resolves to a driver its package ships', () => {
    expect(claimsIn()).toEqual([]);
  });

  test('no card names a product this file has never classified', () => {
    expect(unclassified(real, known)).toEqual([]);
  });

  test('removing a driver from a package fails the sentence that still names it', () => {
    // The claim is checked against the registry the package *exports*, so dropping an entry is
    // enough — there is no second list of "vendors we still claim" that can fall out of date.
    const without = CLAIMS.map((claim) =>
      claim.name === 'S3' ? { ...claim, registry: ['memory', 'local'] } : claim,
    );
    const problems = claimsIn(without);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain('`@tsir/storage` ships no `S3` driver');
    expect(problems[0]?.reason).toContain('memory, local');
  });

  test('a spelling maps to the driver name rather than a prefix match', () => {
    // "Cloudflare Queues" and "Cloudflare KV" share their first word and belong to different
    // packages; a prefix rule would let either stand in for the other.
    expect(
      claimsIn([
        {
          name: 'Cloudflare KV',
          package: '@tsir/queue',
          registry: ['cloudflare-queues'],
          driver: 'cloudflare-kv',
        },
      ]),
    ).toHaveLength(1);
  });

  test('an unclassified vendor keyword is reported by name', () => {
    const tampered = real.replace(
      'data-search="@tsir/cache cache capabilities"',
      'data-search="@tsir/cache cache capabilities AcmeCache"',
    );
    expect(tampered).not.toBe(real);
    expect(unclassified(tampered, known)).toContain('AcmeCache');
  });

  test('an allow-listed name the page dropped is reported, not failed', () => {
    expect(unusedClaims(real)).not.toContain('D1');
    expect(unusedClaims('<article>nothing here</article>')).toContain('D1');
  });

  test('capability vocabulary is not mistaken for a vendor', () => {
    expect(unclassified('<article data-search="cache mail background jobs">', known)).toEqual([]);
  });
});
