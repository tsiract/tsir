import { describe, expect, test } from 'bun:test';
import { localProvider, deploy } from './index.ts';

describe('forge', () => {
  test('creates and lists servers', async () => {
    const p = localProvider();
    const s = await p.create('web-1');
    const list = await p.list();
    const first = list[0];
    expect(list).toHaveLength(1);
    expect(first?.name).toBe('web-1');
    expect(first?.id).toBe(s.id);
  });

  test('destroys servers', async () => {
    const p = localProvider();
    const s = await p.create('web-1');
    await p.destroy(s.id);
    expect(await p.list()).toHaveLength(0);
  });

  test('runs commands locally', async () => {
    const p = localProvider();
    const s = await p.create('web-1');
    const r = await p.run(s.id, 'echo hello');
    expect(r.stdout.trim()).toBe('hello');
    expect(r.exitCode).toBe(0);
  });

  test('deploy runs all steps', async () => {
    const p = localProvider();
    const s = await p.create('web-1');
    const results = await deploy(p, s.id, {
      steps: [
        { name: 'a', command: 'echo a' },
        { name: 'b', command: 'echo b' },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.step).toBe('a');
  });

  test('deploy throws on failed step', async () => {
    const p = localProvider();
    const s = await p.create('web-1');
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(deploy(p, s.id, { steps: [{ name: 'fail', command: 'exit 1' }] })).rejects.toThrow(
      /fail/,
    );
  });
});
