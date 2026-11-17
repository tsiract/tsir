/**
 * What the frontpage is allowed to name (DOCS-008).
 *
 * `check-frontpage.ts` already proves the page is *structurally* honest: a card marked
 * `implemented` has a package directory, a `docs/` link has a source page, no superlative is
 * unqualified. None of that reads the sentence a visitor actually acts on — "drivers for local
 * and object storage", "Cloudinary, Cloudflare, ImageKit, sharp, ffmpeg" — so a driver can be
 * renamed or dropped and the card keeps describing a framework that no longer exists.
 *
 * The rule here is narrow on purpose. A product name in a card is a **claim** that the named
 * package ships a driver for it, and a claim is checkable: the name has to appear in the driver
 * registry that package exports. Names this build knows about are listed in `CLAIMS` with the
 * capability whose registry they must resolve in; a name in no list is reported so that adding a
 * vendor to the marketing page is a decision, not a sentence somebody typed.
 *
 * Two things this deliberately does not do. It does not check that the *feature* works — a driver
 * in the registry with a broken call is a package bug, and the package's own tests own that. And
 * it does not read marketing copy outside the package cards, because "Postgres" in the data
 * diagram is the database engine `@tsir/database` exports as `DATABASE_ENGINES`, verified here by
 * the same rule.
 *
 *   bun src/tools/frontpage-claims.ts        # the gate `make frontpage` runs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROADCAST_DRIVERS } from '../framework/broadcast/src/broadcaster.ts';
import { CACHE_DRIVERS } from '../framework/cache/src/config.ts';
import { DATABASE_ENGINES } from '../framework/database/src/config.ts';
import { MAIL_DRIVERS } from '../framework/mail/src/config.ts';
import { MEDIA_DRIVERS } from '../framework/media/src/config.ts';
import { CHANNEL_DRIVERS } from '../framework/notify/src/config.ts';
import { QUEUE_DRIVERS } from '../framework/queue/src/config.ts';
import { SEARCH_DRIVERS } from '../framework/scout/src/scout.ts';
import { STORAGE_DRIVERS } from '../framework/storage/src/config.ts';

const PAGE = join('src', 'apps', 'frontpage', 'public', 'index.html');

/**
 * A product name the page may use, and what makes it true.
 *
 * `registry` is the driver list the name must be in. `package` is the package whose registry it
 * is — a card for `@tsir/storage` naming S3 is checked against `STORAGE_DRIVERS`, not against a
 * list on this file, so a driver removed from the package fails the page in the same commit.
 */
export interface Claim {
  /** How the page spells it. Matched case-sensitively on word boundaries. */
  readonly name: string;
  readonly package: string;
  readonly registry: readonly string[];
  /** The driver name that makes the claim true, when it differs from the spelling. */
  readonly driver?: string;
}

const compact = (name: string): string => name.toLowerCase().replaceAll(/[\s-]/gu, '');

/**
 * Every vendor-and-driver pair the page is permitted to name.
 *
 * `cloudflare-kv` is a driver; "Cloudflare KV" is how an English sentence says it. The page writes
 * prose, so the mapping from spelling to registry entry is explicit rather than a fuzzy prefix
 * match — "Cloudflare Queues" and "Cloudflare KV" both start with the same word and resolve to
 * different packages.
 */
export const CLAIMS: readonly Claim[] = [
  { name: 'D1', package: '@tsir/database', registry: DATABASE_ENGINES },
  { name: 'Postgres', package: '@tsir/database', registry: DATABASE_ENGINES },
  {
    name: 'Cloudflare KV',
    package: '@tsir/cache',
    registry: CACHE_DRIVERS,
    driver: 'cloudflare-kv',
  },
  { name: 'Redis', package: '@tsir/cache', registry: CACHE_DRIVERS },
  {
    name: 'Cloudflare Queues',
    package: '@tsir/queue',
    registry: QUEUE_DRIVERS,
    driver: 'cloudflare-queues',
  },
  { name: 'SQS', package: '@tsir/queue', registry: QUEUE_DRIVERS },
  { name: 'Resend', package: '@tsir/mail', registry: MAIL_DRIVERS },
  { name: 'Postmark', package: '@tsir/mail', registry: MAIL_DRIVERS },
  { name: 'SendGrid', package: '@tsir/mail', registry: MAIL_DRIVERS },
  { name: 'SES', package: '@tsir/mail', registry: MAIL_DRIVERS },
  { name: 'SMTP', package: '@tsir/mail', registry: MAIL_DRIVERS },
  { name: 'Cloudinary', package: '@tsir/media', registry: MEDIA_DRIVERS },
  { name: 'ImageKit', package: '@tsir/media', registry: MEDIA_DRIVERS },
  { name: 'sharp', package: '@tsir/media', registry: MEDIA_DRIVERS },
  { name: 'ffmpeg', package: '@tsir/media', registry: MEDIA_DRIVERS },
  { name: 'S3', package: '@tsir/storage', registry: STORAGE_DRIVERS },
  { name: 'R2', package: '@tsir/storage', registry: STORAGE_DRIVERS, driver: 's3' },
  { name: 'Typesense', package: '@tsir/scout', registry: SEARCH_DRIVERS },
  { name: 'Meilisearch', package: '@tsir/scout', registry: SEARCH_DRIVERS },
  { name: 'Algolia', package: '@tsir/scout', registry: SEARCH_DRIVERS },
  { name: 'SQLite', package: '@tsir/scout', registry: SEARCH_DRIVERS },
  { name: 'Pusher', package: '@tsir/broadcast', registry: BROADCAST_DRIVERS },
  { name: 'SMS', package: '@tsir/notify', registry: CHANNEL_DRIVERS, driver: 'sms' },
];

/**
 * Product names that appear on the page and are *not* driver claims.
 *
 * Each needs a reason, because the point of this file is that a name on the marketing page says
 * what backs it. A name added here without one would be the prose equivalent of the comment this
 * module replaces.
 */
const NOT_A_DRIVER: ReadonlyMap<string, string> = new Map([
  [
    'Stripe',
    '`@tsir/cashier` is one provider, so the card names it as the package boundary rather than a selectable driver',
  ],
  [
    'Playwright',
    'a test backend, not a runtime capability — `@tsir/nightwatch` ships it and `inMemoryBackend` as peers',
  ],
  ['Bun', 'the runtime the examples are executed with, not a driver'],
  ['Node', 'the runtime the distribution verifies against, not a driver'],
  ['Drizzle', 'the ORM the data layer wraps; it is a dependency of every engine, not one of them'],
  ['Zod', 'a schema library `@tsir/validate` adapts; not a driver'],
  ['Svelte', 'a frontend the admin app uses; no capability resolves to it'],
  ['DaisyUI', "the frontpage's own stylesheet"],
]);

export interface ClaimProblem {
  readonly name: string;
  readonly reason: string;
}

/**
 * Claims the page stops making.
 *
 * `CLAIMS` is a curated allow-list, so it can outlive the sentence it was written for: a card gets
 * rewritten, the name disappears, and the entry stays to be maintained for nothing. That is not a
 * failure — but it is worth printing, because the table is only trustworthy while every row is
 * about something a reader can actually see on the page.
 */
export function unusedClaims(page: string, claims: readonly Claim[] = CLAIMS): readonly string[] {
  return claims.filter((claim) => !page.includes(claim.name)).map((claim) => claim.name);
}

export function claimsIn(claims: readonly Claim[] = CLAIMS): ClaimProblem[] {
  const problems: ClaimProblem[] = [];

  for (const claim of claims) {
    const driver = claim.driver ?? claim.name;
    const present = claim.registry.some((entry) => compact(entry) === compact(driver));
    if (!present) {
      problems.push({
        name: claim.name,
        reason: `the page names ${claim.name} but \`${claim.package}\` ships no \`${driver}\` driver — its registry is ${claim.registry.join(', ')}`,
      });
    }
  }
  return problems;
}

/**
 * Vendors the page mentions that this file has never been told about.
 *
 * The list is a snapshot of capitalised product-ish words in the page, kept honest by being read
 * from the page rather than maintained by hand: every `data-search` keyword is a phrase the card
 * puts in front of a reader, so each one has to resolve here or be listed as prose.
 */
export function unclassified(source: string, known: readonly string[]): readonly string[] {
  const searched = [...source.matchAll(/data-search="([^"]*)"/gu)]
    .flatMap((match) => (match[1] ?? '').split(/\s+/u))
    .map((word) => word.replaceAll(/[^A-Za-z0-9]/gu, ''))
    .filter((word) => word !== '');
  const names = new Set([...known, ...NOT_A_DRIVER.keys()].map(compact));
  // A keyword is a package name, a capability word, or a known product. Only products are checked:
  // `cache`, `mail` and `background` are vocabulary, and demanding a vendor behind each would be a
  // gate nobody could pass.
  return [...new Set(searched)]
    .filter((word) => /^[A-Z@]/u.test(word))
    .filter((word) => !names.has(compact(word)) && !word.startsWith('@tsir'))
    .sort();
}

if (import.meta.main) {
  const source = readFileSync(PAGE, 'utf8');
  const problems = claimsIn();
  const unknown = unclassified(
    source,
    CLAIMS.map((claim) => claim.name),
  );
  const unused = unusedClaims(source);

  if (problems.length > 0) {
    process.stderr.write(`\nfrontpage driver claims failed (${String(problems.length)})\n\n`);
    for (const problem of problems) process.stderr.write(`  ✗ ${problem.reason}\n`);
    process.stderr.write(
      '\n  Either restore the driver in the package, or stop naming it on the page.\n\n',
    );
    process.exit(1);
  }
  if (unknown.length > 0) {
    process.stderr.write(
      `\nfrontpage names an unclassified product (${String(unknown.length)})\n\n`,
    );
    for (const name of unknown) {
      process.stderr.write(
        `  ✗ "${name}" is in a card's search keywords but no claim in frontpage-claims.ts backs it\n`,
      );
    }
    process.stderr.write(
      '\n  Add it to CLAIMS (checked against a driver registry) or to NOT_A_DRIVER (with a reason).\n\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `✓ frontpage claims resolve (${String(CLAIMS.length)} product names against package registries, ` +
      `${String(CLAIMS.length - unused.length)} used by the page)\n`,
  );
  if (unused.length > 0) {
    process.stdout.write(
      `  · ${String(unused.length)} allow-listed name(s) the page no longer uses: ${unused.join(', ')}\n`,
    );
  }
}
