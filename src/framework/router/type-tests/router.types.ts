/**
 * Type-level tests for `@tsir/router` route declarations (TST-010, partial).
 *
 * What is checked here: the declarative route surface rejects shapes that would otherwise only
 * fail at boot. Handler argument inference from `params` and `body` is not in the router yet
 * (the schemas are validated at runtime, see `RouteMeta`), so those cases are not asserted here
 * and TST-010 stays open for them.
 */

import { Get, Post, type RouteMeta } from '../src/index.ts';

// A path must start with `/`.
// @ts-expect-error: paths are `/${string}`
void Get('users');

// A valid path compiles.
void Get('/users');
void Post('/users', { status: 201 });

// An unknown status is rejected by the type.
// @ts-expect-error: 299 is not a declared RouteStatus
const badStatus: RouteMeta = { method: 'GET', path: '/x', status: 299 };
void badStatus;
