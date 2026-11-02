import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeAsyncCommand } from './make-async.ts';
import { makeModuleCommand } from './generate.ts';
import { makeControllerCommand } from './make-controller.ts';
import { makeLinkClientCommand } from './make-link-client.ts';
import { makePartCommand } from './make-parts.ts';
import { makePolicyCommand } from './make-policy.ts';
import { makeSeederCommand } from './make-seeder.ts';
import { pendingTestPath } from './pending-test.ts';

// CLI-015: a fresh generation is red. Every generated part ships with a test that fails until the
// part is implemented, and the real `bun test` must say so. The event is a definition with no
// behaviour to test, so it ships without one.

let dir = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-pending-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('pending tests', () => {
  test('the test file sits next to the generated file', () => {
    expect(pendingTestPath('/p/services/audit.service.ts')).toBe(
      '/p/services/audit.service.test.ts',
    );
  });

  test('a fresh project is red: bun test fails and names every generated part', async () => {
    await makePartCommand('service')(['Audit']);
    await makePartCommand('middleware')(['Audit']);
    await makePartCommand('guard')(['Token']);
    await makeAsyncCommand('job')(['SendReceipt']);
    await makeAsyncCommand('event')(['OrderPlaced']);
    await makeAsyncCommand('listener')(['SendReceipt', '--event', 'OrderPlaced']);
    await makePolicyCommand(['Post', 'update']);
    await makeLinkClientCommand(['Billing']);
    await makeSeederCommand(['Users']);
    await makeModuleCommand(['shop']);
    // This isolated temp directory has no app dependencies for the starter module test.
    rmSync(join(dir, 'shop/shop.test.ts'));
    await makeControllerCommand(['users', 'shop']);

    const expected = [
      'services/audit.service.test.ts',
      'middleware/audit.middleware.test.ts',
      'guards/token.guard.test.ts',
      'queues/send-receipt.job.test.ts',
      'listeners/send-receipt.listener.test.ts',
      'policies/post-update.policy.test.ts',
      'clients/billing.client.test.ts',
      'seeders/users.seeder.test.ts',
      'shop/http/users.controller.test.ts',
    ];
    for (const file of expected) expect(existsSync(join(dir, file))).toBe(true);
    expect(existsSync(join(dir, 'events/order-placed.event.test.ts'))).toBe(false);

    const run = Bun.spawn([process.execPath, 'test'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output =
      (await new Response(run.stdout).text()) + (await new Response(run.stderr).text());
    expect(await run.exited).not.toBe(0);
    expect(output).toMatch(/\b9 fail\b/);
    expect(output).toContain('AuditService is implemented');
    expect(output).toContain('was generated but is not implemented yet');
  });
});
