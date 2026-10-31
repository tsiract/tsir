import { describe, expect, test } from 'bun:test';

import { planActivation, planRetire } from './activate.ts';
import { createKeyring } from './keyring.ts';
import { formatKeySpec, generateKey } from './keys.ts';

function codeOf(work: () => unknown): string {
  try {
    work();
    return 'none';
  } catch (reason: unknown) {
    return (reason as { code?: string }).code ?? 'no-code';
  }
}

const OLD = formatKeySpec(generateKey());
const OLD_ID = OLD.split(':')[0] as string;
const NEW = formatKeySpec(generateKey());
const NEW_ID = NEW.split(':')[0] as string;
const THIRD = formatKeySpec(generateKey());
const THIRD_ID = THIRD.split(':')[0] as string;

describe('vault:key:activate plans a legal promotion (VLT-016)', () => {
  test('the promoted key is the writer and the old one keeps decrypting', () => {
    const plan = planActivation({ now: OLD, next: NEW });

    expect(plan.fromKeyId).toBe(OLD_ID);
    expect(plan.toKeyId).toBe(NEW_ID);
    expect(plan.env.APP_KEY_NOW).toBe(NEW);
    expect(plan.env.APP_KEY_NEXT).toBe('');

    const states = new Map(plan.manifest.map((entry) => [entry.id, entry.state]));
    expect(states.get(NEW_ID)).toBe('active');
    expect(states.get(OLD_ID)).toBe('decrypt-only');
  });

  test('the resulting manifest boots as a keyring', () => {
    const plan = planActivation({ now: OLD, next: NEW });

    // The strongest assertion available: the output is fed back through the same
    // validator every instance runs at boot.
    const keyring = createKeyring({ now: plan.env.APP_KEY_NOW, manifest: plan.manifest });

    expect(keyring.active.id).toBe(NEW_ID);
    expect([...keyring.decryptKeyIds].sort()).toEqual([OLD_ID, NEW_ID].sort());
  });

  test('decrypt-only keys from an earlier rotation survive the manifest', () => {
    const plan = planActivation({
      now: OLD,
      next: NEW,
      manifest: [
        { id: OLD_ID, alg: 'aes-256-gcm', state: 'active' },
        { id: THIRD_ID, alg: 'aes-256-gcm', state: 'decrypt-only' },
      ],
    });

    const states = new Map(plan.manifest.map((entry) => [entry.id, entry.state]));
    expect(states.get(THIRD_ID)).toBe('decrypt-only');
    expect(states.get(OLD_ID)).toBe('decrypt-only');
    expect(states.get(NEW_ID)).toBe('active');
  });

  test('a staged entry already in the manifest is promoted, not duplicated', () => {
    const plan = planActivation({
      now: OLD,
      next: NEW,
      manifest: [
        { id: OLD_ID, alg: 'aes-256-gcm', state: 'active' },
        { id: NEW_ID, alg: 'aes-256-gcm', state: 'staged' },
      ],
    });

    expect(plan.manifest.filter((entry) => entry.id === NEW_ID)).toHaveLength(1);
    expect(plan.manifest.find((entry) => entry.id === NEW_ID)?.state).toBe('active');
  });

  test('the plan is safe to re-run', () => {
    const first = planActivation({ now: OLD, next: NEW });
    // Second run: NEW is now APP_KEY_NOW, nothing is staged.
    expect(codeOf(() => planActivation({ now: NEW, next: '' }))).toBe('VLT_NOT_CONFIGURED');

    // And activating NEW again while it is already active is refused as a no-op.
    expect(codeOf(() => planActivation({ now: NEW, next: NEW }))).toBe('VLT_KEYRING_INVALID');
    expect(first.env.APP_KEY_NOW).toBe(NEW);
  });

  test('nothing staged is an environment problem with the runbook step in the hint', () => {
    const error = (() => {
      try {
        planActivation({ now: OLD, next: undefined });
        return undefined;
      } catch (reason: unknown) {
        return reason as { code?: string; message?: string; hint?: string };
      }
    })();

    expect(error?.code).toBe('VLT_NOT_CONFIGURED');
    expect(error?.message).toContain('APP_KEY_NEXT');
    expect(error?.hint).toContain('vault:key:generate');
  });

  test('a manifest that disagrees with APP_KEY_NOW fails before anything is printed', () => {
    // VLT-014: the deployed manifest does not carry the current writer.
    expect(
      codeOf(() =>
        planActivation({
          now: OLD,
          next: NEW,
          manifest: [{ id: THIRD_ID, alg: 'aes-256-gcm', state: 'decrypt-only' }],
        }),
      ),
    ).toBe('VLT_KEYRING_MISMATCH');
  });

  test('the changes read in the order an operator applies them', () => {
    const plan = planActivation({ now: OLD, next: NEW, nowIso: '2026-10-28T00:00:00.000Z' });

    expect(plan.changes[0]).toBe(`promote ${NEW_ID} (writing since APP_KEY_NEXT was deployed)`);
    expect(plan.changes[1]).toBe(`keep ${OLD_ID} as decrypt-only`);
    expect(plan.changes[2]).toContain('APP_KEY_NOW');
    expect(plan.appliedAt).toBe('2026-10-28T00:00:00.000Z');
  });
});

describe('rolling deploy (matrix row 14, VLT-018)', () => {
  const COLUMN = { table: 'users', column: 'tax_id' } as const;

  test('an old instance meets a new-key row and says so instead of guessing', async () => {
    const { createVault } = await import('./cipher.ts');

    // 1. Before the deploy: one instance, one key.
    const oldInstance = await createVault({ keyring: createKeyring({ now: OLD }) });

    // 2. The promotion happens and a new instance writes with NEW.
    const plan = planActivation({ now: OLD, next: NEW });
    const newInstance = await createVault({
      keyring: createKeyring({
        now: plan.env.APP_KEY_NOW,
        manifest: plan.manifest,
        // The old material is still deployed as a secret — that is what makes the
        // demotion to `decrypt-only` useful rather than decorative.
        materials: { [OLD_ID]: OLD },
      }),
    });
    const written = await newInstance.encrypt(COLUMN, '123-45-6789');

    // 3. The old instance — still serving traffic during the rollout — must fail
    //    closed. Not plaintext, not an empty string, and not a different error
    //    that would send the operator looking at the ciphertext.
    const error = await oldInstance.decrypt(COLUMN, written).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );
    expect(error?.code).toBe('VLT_UNKNOWN_KEY');

    // 4. The new instance reads its own write, and the old key's rows too.
    expect(await newInstance.decrypt(COLUMN, written)).toBe('123-45-6789');
    const oldRow = await oldInstance.encrypt(COLUMN, 'old-row');
    expect(await newInstance.decrypt(COLUMN, oldRow)).toBe('old-row');
  });

  test('a decrypt-only key with no material fails at boot, not on the first read', async () => {
    const { createVault } = await import('./cipher.ts');
    const plan = planActivation({ now: OLD, next: NEW });

    const error = await createVault({
      keyring: createKeyring({ now: plan.env.APP_KEY_NOW, manifest: plan.manifest }),
    }).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string; message?: string },
    );

    expect(error?.code).toBe('VLT_INVALID_KEY_MATERIAL');
    expect(error?.message).toContain(OLD_ID);
  });
});

describe('vault:key:retire plans a guarded retirement (VLT-017)', () => {
  /** The deployed shape after `vault:key:activate`: NEW is active, OLD decrypts. */
  function deployed() {
    return {
      keys: [
        { id: OLD_ID, alg: 'aes-256-gcm' as const, state: 'decrypt-only' as const },
        { id: NEW_ID, alg: 'aes-256-gcm' as const, state: 'active' as const },
      ],
      materials: { [OLD_ID]: OLD, [NEW_ID]: NEW },
    };
  }

  test('a decrypt-only key with no rows left retires, and its material is dropped', () => {
    const manifest = deployed();
    const plan = planRetire({
      keyId: OLD_ID,
      manifest: manifest.keys,
      materials: manifest.materials,
      remaining: 0,
      activeKeyId: NEW_ID,
      nowIso: '2026-10-28T00:00:00.000Z',
    });

    expect(plan.fromState).toBe('decrypt-only');
    expect(plan.forced).toBe(false);
    expect(plan.manifest.find((entry) => entry.id === OLD_ID)?.state).toBe('retired');
    expect(Object.keys(plan.materials)).toEqual([NEW_ID]);

    // The output has to be a keyring a deployment can boot with — otherwise the
    // "plan" is a manifest that looks right and fails at 3 a.m.
    const keyring = createKeyring({
      now: NEW,
      manifest: plan.manifest,
      materials: plan.materials,
    });
    expect(keyring.active.id).toBe(NEW_ID);
  });

  test('a key that rows still reference is refused, with the count', () => {
    const manifest = deployed();
    const error = (() => {
      try {
        planRetire({
          keyId: OLD_ID,
          manifest: manifest.keys,
          materials: manifest.materials,
          remaining: 42,
          activeKeyId: NEW_ID,
        });
        return undefined;
      } catch (reason: unknown) {
        return reason as { code: string; message: string; hint: string };
      }
    })();

    expect(error?.code).toBe('VLT_STALE_KEY');
    expect(error?.message).toContain('42 row(s)');
    expect(error?.hint).toContain('vault:rotate');
  });

  test('--force retires anyway, and says so in the plan', () => {
    const manifest = deployed();
    const plan = planRetire({
      keyId: OLD_ID,
      manifest: manifest.keys,
      materials: manifest.materials,
      remaining: 42,
      activeKeyId: NEW_ID,
      force: true,
    });

    expect(plan.forced).toBe(true);
    expect(plan.changes.join(' ')).toContain('VLT_UNKNOWN_KEY');
  });

  test('the writer cannot be retired, whether it is active or staged', () => {
    const manifest = deployed();

    expect(
      codeOf(() =>
        planRetire({
          keyId: NEW_ID,
          manifest: manifest.keys,
          materials: manifest.materials,
          remaining: 0,
          activeKeyId: NEW_ID,
        }),
      ),
    ).toBe('VLT_KEY_STILL_ACTIVE');

    // ADR-0021: `APP_KEY_NEXT` is the writer, so a `staged` key is just as unretirable.
    expect(
      codeOf(() =>
        planRetire({
          keyId: THIRD_ID,
          manifest: [
            { id: NEW_ID, alg: 'aes-256-gcm', state: 'active' },
            { id: THIRD_ID, alg: 'aes-256-gcm', state: 'staged' },
          ],
          remaining: 0,
          activeKeyId: THIRD_ID,
        }),
      ),
    ).toBe('VLT_KEY_STILL_ACTIVE');
  });

  test('an unknown or already-retired key is refused by the keyring rules', () => {
    const manifest = deployed();

    expect(codeOf(() => planRetire({ keyId: 'nope', manifest: manifest.keys, remaining: 0 }))).toBe(
      'VLT_UNKNOWN_KEY',
    );

    expect(
      codeOf(() =>
        planRetire({
          keyId: OLD_ID,
          manifest: [{ id: OLD_ID, alg: 'aes-256-gcm', state: 'retired' }],
          remaining: 0,
        }),
      ),
    ).toBe('VLT_KEYRING_INVALID');
  });

  test('a staged key that was never activated retires straight to retired', () => {
    const plan = planRetire({
      keyId: THIRD_ID,
      manifest: [
        { id: NEW_ID, alg: 'aes-256-gcm', state: 'active' },
        { id: THIRD_ID, alg: 'aes-256-gcm', state: 'staged' },
      ],
      remaining: 0,
      activeKeyId: NEW_ID,
    });

    expect(plan.fromState).toBe('staged');
    expect(plan.manifest.find((entry) => entry.id === THIRD_ID)?.state).toBe('retired');
  });
});
