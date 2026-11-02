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

import { createEvents, type ListenerDefinition } from '@tsir/events';
import { createJobRegistry, type JobDefinition } from '@tsir/queue';

import { EXIT } from '../output.ts';
import { makeAsyncCommand } from './make-async.ts';

// CLI-013: the generated files import `@tsir/events` and `@tsir/queue`, which a scratch project
// outside the repository cannot resolve. The runtime tests therefore rewrite those two specifiers
// in the temp copy to the repository's source, and then load the files and hand them to the real
// `createEvents` and `createJobRegistry`. Nothing else is changed.

const SRC = resolve(import.meta.dir, '..', '..', '..');
const SPECIFIERS: Readonly<Record<string, string>> = {
  '@tsir/events': join(SRC, 'events', 'src', 'index.ts'),
  '@tsir/queue': join(SRC, 'queue', 'src', 'index.ts'),
};

const make = {
  job: makeAsyncCommand('job'),
  event: makeAsyncCommand('event'),
  listener: makeAsyncCommand('listener'),
};

let dir = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-async-'));
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

/** Rewrites the two package specifiers in every generated file under the app root. */
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
      text = text.replaceAll(`'${specifier}'`, `'${target}'`);
    }
    writeFileSync(file, text);
  }
}

describe('make:job', () => {
  test('writes a defineJob file whose name is the kebab stem and which the registry accepts', async () => {
    expect(await make.job(['SendReceipt'])).toBe(EXIT.ok);
    const path = join(dir, 'queues', 'send-receipt.job.ts');
    expect(existsSync(path)).toBe(true);
    linkToSource();

    const mod = (await import(path)) as { SendReceiptJob: JobDefinition<{ id: string }> };
    expect(mod.SendReceiptJob.name).toBe('send-receipt');
    expect(mod.SendReceiptJob.maxAttempts).toBe(5);

    expect(createJobRegistry([mod.SendReceiptJob]).has('send-receipt')).toBe(true);
  });
});

describe('make:event', () => {
  test('derives a dotted name from the class and accepts an explicit --name', async () => {
    expect(await make.event(['OrderPlaced'])).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'events', 'order-placed.event.ts'), 'utf8')).toContain(
      "name: 'order.placed'",
    );

    expect(await make.event(['Invoice', '--name', 'billing.invoice.sent'])).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'events', 'invoice.event.ts'), 'utf8')).toContain(
      "name: 'billing.invoice.sent'",
    );
  });

  test('refuses a name that is not a dotted lowercase name', async () => {
    expect(await rejectionOf(make.event(['OrderPlaced', '--name', 'Order Placed']))).toContain(
      'not a dotted lowercase event name',
    );
  });

  test('the generated event is accepted by defineEvent and keeps its typed payload', async () => {
    await make.event(['OrderPlaced']);
    linkToSource();
    const mod = (await import(join(dir, 'events', 'order-placed.event.ts'))) as {
      OrderPlacedEvent: { name: string; mode: string };
    };
    expect(mod.OrderPlacedEvent.name).toBe('order.placed');
    expect(mod.OrderPlacedEvent.mode).toBe('queued');
  });
});

describe('make:listener', () => {
  test('needs --event and refuses an event that is not generated yet', async () => {
    expect(await rejectionOf(make.listener(['SendReceipt']))).toContain('needs --event');
    expect(await rejectionOf(make.listener(['SendReceipt', '--event', 'OrderPlaced']))).toContain(
      'is not defined',
    );
    expect(existsSync(join(dir, 'listeners'))).toBe(false);
  });

  test('is accepted by createEvents for the event it names, and its payload comes from that event', async () => {
    await make.event(['OrderPlaced']);
    expect(await make.listener(['SendReceipt', '--event', 'OrderPlaced'])).toBe(EXIT.ok);
    linkToSource();

    const listenerPath = join(dir, 'listeners', 'send-receipt.listener.ts');
    const listenerMod = (await import(listenerPath)) as {
      SendReceiptListener: ListenerDefinition<{ id: string }>;
    };
    expect(listenerMod.SendReceiptListener.name).toBe('send-receipt');
    expect(listenerMod.SendReceiptListener.event.name).toBe('order.placed');

    expect(() => createEvents({ listeners: [listenerMod.SendReceiptListener] })).not.toThrow();
  });

  test('--event accepts the class with or without the Event suffix', async () => {
    await make.event(['OrderPlaced']);
    expect(await make.listener(['Notify', '--event', 'OrderPlacedEvent'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'listeners', 'notify.listener.ts'))).toBe(true);
  });
});

describe('shared behaviour', () => {
  test('--dry-run writes nothing', async () => {
    expect(await make.job(['SendReceipt', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'queues'))).toBe(false);
  });

  test('refuses to overwrite without --force', async () => {
    await make.job(['SendReceipt']);
    expect(await rejectionOf(make.job(['SendReceipt']))).toContain('refusing to overwrite');
  });

  test('a missing name is a usage error', async () => {
    expect(await rejectionOf(make.event([]))).toContain('needs a name');
  });
});
