import { describe, expect, test } from 'bun:test';

import { assertTransition, canTransition, createKeyring, keyringManifest } from './keyring.ts';
import { formatKeySpec, generateKey } from './keys.ts';

function codeOf(work: () => unknown): string {
  try {
    work();
    return 'none';
  } catch (reason: unknown) {
    return (reason as { code?: string }).code ?? 'no-code';
  }
}

const NOW = formatKeySpec(generateKey());
const NOW_ID = NOW.split(':')[0] as string;
const OTHER = formatKeySpec(generateKey());
const OTHER_ID = OTHER.split(':')[0] as string;

describe('the keyring (VLT-010 … VLT-014)', () => {
  test('the active key comes from APP_KEY_NOW and is the only encrypting key', () => {
    const keyring = createKeyring({ now: NOW });

    expect(keyring.active.id).toBe(NOW_ID);
    expect(keyring.active.state).toBe('active');
    expect(keyring.decryptKeyIds).toEqual([NOW_ID]);
    expect(keyring.entries).toHaveLength(1);
  });

  test('an unset vault is a boot error, not a runtime surprise', () => {
    expect(codeOf(() => createKeyring({}))).toBe('VLT_NOT_CONFIGURED');
    expect(codeOf(() => createKeyring({ now: '   ' }))).toBe('VLT_NOT_CONFIGURED');
  });

  test('APP_KEY_NEXT becomes the writer, APP_KEY_NOW stays as decrypt-only', () => {
    const keyring = createKeyring({ now: NOW, next: OTHER });

    expect(keyring.active.id).toBe(OTHER_ID);
    expect(keyring.entry(NOW_ID)?.state).toBe('decrypt-only');
    // Both decrypt: that is what makes the switch safe for rows already on disk.
    expect([...keyring.decryptKeyIds].sort()).toEqual([NOW_ID, OTHER_ID].sort());
    // The writer is listed first, so output reads writer-then-previous.
    expect(keyring.entries[0]?.id).toBe(OTHER_ID);
  });

  test('a NEXT that repeats NOW is refused', () => {
    expect(codeOf(() => createKeyring({ now: NOW, next: NOW }))).toBe('VLT_KEYRING_INVALID');
  });

  test('two active keys are refused, whichever source disagrees', () => {
    const error = (() => {
      try {
        createKeyring({
          now: NOW,
          manifest: [
            { id: NOW_ID, alg: 'aes-256-gcm', state: 'active' },
            { id: OTHER_ID, alg: 'aes-256-gcm', state: 'active' },
          ],
        });
        return undefined;
      } catch (reason: unknown) {
        return reason as { code?: string; message?: string };
      }
    })();

    expect(error?.code).toBe('VLT_KEYRING_INVALID');
    // The message names both, because "two active keys" without ids is a puzzle.
    expect(error?.message).toContain(NOW_ID);
    expect(error?.message).toContain(OTHER_ID);
  });

  test('APP_KEY_NOW missing from the deployed manifest fails the rollout guard', () => {
    const error = (() => {
      try {
        createKeyring({
          now: NOW,
          manifest: [{ id: OTHER_ID, alg: 'aes-256-gcm', state: 'decrypt-only' }],
        });
        return undefined;
      } catch (reason: unknown) {
        return reason as { code?: string; message?: string; hint?: string };
      }
    })();

    expect(error?.code).toBe('VLT_KEYRING_MISMATCH');
    expect(error?.message).toContain(NOW_ID);
    // The fix is deploy-order, and the hint says so.
    expect(error?.hint).toContain('before switching APP_KEY_NOW');
  });

  test('decrypt-only keys decrypt but never encrypt', () => {
    const keyring = createKeyring({
      now: NOW,
      manifest: [
        { id: NOW_ID, alg: 'aes-256-gcm', state: 'active' },
        { id: OTHER_ID, alg: 'aes-256-gcm', state: 'decrypt-only' },
      ],
      next: undefined,
    });

    expect([...keyring.decryptKeyIds].sort()).toEqual([NOW_ID, OTHER_ID].sort());
    expect(keyring.active.id).toBe(NOW_ID);
  });

  test('a staged key in the manifest stays out of the decrypt set', () => {
    const keyring = createKeyring({
      now: NOW,
      manifest: [
        { id: NOW_ID, alg: 'aes-256-gcm', state: 'active' },
        { id: OTHER_ID, alg: 'aes-256-gcm', state: 'staged' },
      ],
    });

    expect(keyring.decryptKeyIds).toEqual([NOW_ID]);
  });

  test('duplicate ids and unknown states are refused', () => {
    expect(
      codeOf(() =>
        createKeyring({
          now: NOW,
          manifest: [
            { id: NOW_ID, alg: 'aes-256-gcm', state: 'active' },
            { id: NOW_ID, alg: 'aes-256-gcm', state: 'decrypt-only' },
          ],
        }),
      ),
    ).toBe('VLT_KEYRING_INVALID');

    expect(
      codeOf(() =>
        createKeyring({
          now: NOW,
          manifest: [{ id: NOW_ID, alg: 'aes-256-gcm', state: 'half-retired' as 'retired' }],
        }),
      ),
    ).toBe('VLT_KEYRING_INVALID');
  });

  test('bad material names the key id and never the material', () => {
    const shortMaterial = `${NOW_ID}:aes-256-gcm:AAAA`;
    const error = (() => {
      try {
        createKeyring({ now: shortMaterial });
        return undefined;
      } catch (reason: unknown) {
        return reason as { code?: string; message?: string };
      }
    })();

    expect(error?.code).toBe('VLT_INVALID_KEY_MATERIAL');
    expect(error?.message).toContain(NOW_ID);
    expect(error?.message).not.toContain('AAAA');
  });

  test('the state machine allows only the documented transitions', () => {
    expect(canTransition('staged', 'active')).toBe(true);
    expect(canTransition('active', 'decrypt-only')).toBe(true);
    expect(canTransition('decrypt-only', 'retired')).toBe(true);
    // Skipping a step is how a key becomes unreadable while rows still reference it.
    expect(canTransition('staged', 'decrypt-only')).toBe(false);
    expect(canTransition('retired', 'active')).toBe(false);

    const error = (() => {
      try {
        assertTransition('retired', 'active');
        return undefined;
      } catch (reason: unknown) {
        return reason as { code?: string; message?: string };
      }
    })();
    expect(error?.code).toBe('VLT_KEYRING_INVALID');
    expect(error?.message).toContain('retired');
    expect(error?.message).toContain('active');
  });

  test('the deployable manifest omits staged keys', () => {
    const keyring = createKeyring({
      now: NOW,
      manifest: [
        { id: NOW_ID, alg: 'aes-256-gcm', state: 'active' },
        { id: OTHER_ID, alg: 'aes-256-gcm', state: 'staged' },
      ],
    });

    expect(keyringManifest(keyring).map((entry) => entry.state)).toEqual(['active']);
  });
});

describe('material for keys the environment does not carry (VLT-010)', () => {
  test('a decrypt-only key gets its material from the deployed manifest', () => {
    const keyring = createKeyring({
      now: NOW,
      manifest: [
        { id: NOW_ID, alg: 'aes-256-gcm', state: 'active' },
        { id: OTHER_ID, alg: 'aes-256-gcm', state: 'decrypt-only' },
      ],
      materials: { [OTHER_ID]: OTHER },
    });

    expect(keyring.keys.has(OTHER_ID)).toBe(true);
    expect(keyring.decryptKeyIds).toContain(OTHER_ID);
  });

  test('material filed under the wrong id is refused', () => {
    expect(
      codeOf(() =>
        createKeyring({
          now: NOW,
          manifest: [{ id: OTHER_ID, alg: 'aes-256-gcm', state: 'decrypt-only' }],
          // The spec says NOW_ID; the map key says OTHER_ID.
          materials: { [OTHER_ID]: NOW },
        }),
      ),
    ).toBe('VLT_KEYRING_INVALID');
  });

  test('material with an unusable id is refused before it is parsed', () => {
    expect(codeOf(() => createKeyring({ now: NOW, materials: { AB: NOW } }))).toBe(
      'VLT_KEYRING_INVALID',
    );
  });
});
