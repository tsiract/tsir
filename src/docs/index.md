# Tsir documentation

Tsir is a backend-only TypeScript framework for **Bun**, **Cloudflare Workers** and **AWS Lambda**:
one codebase, all three targets, sized to fit inside each free tier. It gives you routing,
validation, Drizzle-backed persistence, queues, caching, mail, auth, scheduling and search behind
ports whose drivers you choose by name, so moving a service from Cloudflare to AWS is a config line
rather than a rewrite.

It is pre-alpha and not published to npm. Read [compatibility](./compatibility.md) before depending
on it.

## If you are a human, in a hurry

Three commands get you a running app. This is the whole fast path:

```sh
tsir new hello          # create a project (outside the distribution directory)
cd hello
bun install --ignore-scripts
tsir dev                # http://127.0.0.1:3000 → {"message":"Welcome to Tsir"}
```

Then [installation](./installation.md) explains where the `tsir` command comes from, what a
generated project looks like, and why `app.ts` — not a glob over your folders — decides what boots.
Add [controllers](./guides/controllers.md) for routes and
[models and queries](./guides/database.md) for persistence.

There is exactly one right way to do each thing, and the guides exist so you do not have to guess
which of three approaches this framework chose. Start with the one for the job in front of you.

## If you are an AI agent, start here

Do not infer conventions from the file tree — several of them are enforced by gates that will reject
a change that looks fine. In order:

1. `AGENTS.md` at the repository root: what the project is, how to verify a change, which gates
   will reject a plausible one, and the explicit do-not list. (Linked as a path, not a link: the
   docs site refuses links that leave this folder, so a link here would break the build.)
2. `llms.txt`, also at the repository root: a generated index of every document with a one-line
   summary of each. Every path in it resolves or the build fails, so it is safe to follow.
3. [`src/docs/error-codes.json`](./error-codes.json): every error code as data. Grep it before
   inventing one — codes are a shared namespace and duplicates are rejected.
4. [`src/docs/api-surface.json`](./api-surface.json): the exact exports of every package. If a
   symbol is not in this file it is not public, whatever the source says.

The commands that answer "is my change sane?" are `make check` (gates only, offline, no tests, about
five minutes) and `make verify` (gates **and** the test suite). `make check` alone passing does not
mean the tests pass; CI runs both.

## Guides: one per job

Read these in order when learning the framework, or jump to the one you need.

- [Configuration and secrets](./guides/configuration.md) — what lives in `tsir.js`, what lives in
  the environment, and why neither creates a runtime client for you.
- [Controllers and HTTP routes](./guides/controllers.md) — grouping actions in plain classes.
- [Models, Drizzle queries and migrations](./guides/database.md) — why there is no Active Record
  base class.
- [Jobs and queues](./guides/queues.md) — work that should not happen inside a request.
- [Caching](./guides/caching.md) — skipping work that has already been done.
- [Search](./guides/search.md) — full-text search across six engines behind one port.
- [Moving between Cloudflare and AWS](./guides/providers.md) — the same app on either target.
- [Services, drivers, and defaults](./guides/drivers.md) — which driver each capability uses by
  default on each target, and what each one requires. Read this before going to production: the
  starter's defaults are deliberately ephemeral.
- [Contributor build commands](./guides/make.md) — the Makefile, for building the framework itself
  rather than an app.

## Reference

- [Capability matrix](./capabilities.md) — what runs where, and what each target does not offer.
- [Error codes](./errors.md) — every code a framework package can raise, and what to do about it.
- [Compatibility policy](./compatibility.md) — what a version number promises and how to upgrade.
- [Migrations and seeding runbook](./migrations.md) — every `tsir migrate:*` and `tsir db:seed`
  command.
- [Runtime dependencies](./dependencies.md) — what an application actually ships.
- [Third-party attributions](./attributions.md) — licences of everything bundled or depended on.
- [Package reference](./packages/index.md) — one page per package: what it supports, what it
  refuses, and its failure modes.

## Status

The project is pre-alpha. The README states what is real today; the capability matrix states what is
proven on each target. Anything marked open in the task index is not built yet, and the docs do not
claim otherwise.
