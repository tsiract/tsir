#!/usr/bin/env bun
/**
 * The `tsir` CLI entry point.
 *
 * One binary, an explicit command table, and stable exit codes:
 *   0 success · 1 operation failed · 2 usage error · 3 environment problem
 *
 * Commands that belong to later phases are listed here and fail with an
 * environment error that names the phase that will provide it — never with a stack
 * trace, and never by silently doing nothing.
 */

import { runCli } from './index.ts';

process.exit(await runCli(Bun.argv.slice(2)));
