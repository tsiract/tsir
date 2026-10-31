/**
 * `vault:key:activate` — the promotion step of the rotation runbook
 * (`VLT-016`, `06-vault.md § 4` step 3).
 *
 * The command itself is one line of output; **this** file is the part worth
 * testing, because a promotion that produces an illegal keyring is how a project
 * ends up with two writers or zero readers. So the plan is computed, re-validated
 * as a keyring, and only then handed to the CLI to print.
 *
 * What "activate" means concretely:
 *
 *   · the key named by `APP_KEY_NEXT` becomes `APP_KEY_NOW` (it encrypts);
 *   · the key that was `APP_KEY_NOW` stays in the decrypt set as `decrypt-only`,
 *     because rows written before the switch still reference it;
 *   · nothing else changes. `staged` entries added by a not-yet-activated deploy
 *     are dropped from the manifest, which is what makes the output re-runnable.
 *
 * The result is deliberately **not applied** here. There is no file this package
 * could write that a production instance would read: the material lives in a secret
 * manager, and the manifest is deployed as a secret. So the CLI prints the exact
 * changes, and a human or a pipeline applies them — the same shape as
 * `config:dump` (no side effects a second run would duplicate).
 */

import {
  assertTransition,
  createKeyring,
  keyringManifest,
  type KeyringEntry,
  type KeyState,
} from './keyring.ts';
import { formatKeySpec, keyIdOf, parseKeySpec } from './keys.ts';
import { invalidKeyring, keyStillActive, notConfigured, staleKey, unknownKey } from './errors.ts';

export interface ActivationPlanInput {
  /** `APP_KEY_NOW`: the material that encrypts right now. */
  readonly now: string;
  /** `APP_KEY_NEXT`: the material to promote. */
  readonly next: string | undefined;
  /** `TSIR_KEYRING_FILE`, already parsed. */
  readonly manifest?: readonly KeyringEntry[] | undefined;
  /** Material for keys the manifest lists (`TSIR_KEYRING_FILE` materials). */
  readonly materials?: Readonly<Record<string, string>> | undefined;
  /** ISO timestamp recorded in the plan's output for operators. */
  readonly nowIso?: string | undefined;
}

export interface ActivationPlan {
  readonly fromKeyId: string;
  readonly toKeyId: string;
  /** The two env values a deployment must carry after this plan is applied. */
  readonly env: { readonly APP_KEY_NOW: string; readonly APP_KEY_NEXT: string };
  /** The manifest to deploy — the source of truth for every other instance. */
  readonly manifest: readonly KeyringEntry[];
  /** Human lines, in the order they should be read. */
  readonly changes: readonly string[];
  readonly appliedAt: string | undefined;
}

/**
 * Computes the promotion without performing it.
 *
 * Throws `VLT_NOT_CONFIGURED` when there is nothing staged (the most common
 * mistake: running `activate` before deploying `APP_KEY_NEXT`), and
 * `VLT_KEYRING_INVALID` for anything that would break an invariant.
 */
export function planActivation(input: ActivationPlanInput): ActivationPlan {
  if (input.next === undefined || input.next.trim() === '') {
    throw notConfigured(
      'there is nothing to activate: APP_KEY_NEXT is empty — deploy the new material first (06-vault.md § 4 step 2)',
    );
  }

  const keyring = createKeyring({
    now: input.now,
    next: input.next,
    ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    ...(input.materials === undefined ? {} : { materials: input.materials }),
  });

  const fromKeyId = keyIdOf(input.now);
  const nextKey = parseKeySpec(input.next);
  const toKeyId = nextKey.id;

  if (fromKeyId === toKeyId) {
    throw invalidKeyring(`APP_KEY_NEXT names the active key "${toKeyId}"`, { keyId: toKeyId });
  }

  assertTransition('staged', 'active');
  assertTransition('active', 'decrypt-only');

  // The keyring already resolves `APP_KEY_NEXT` as the writer, so the post-plan
  // manifest is the current one minus `staged` — the demotion of the old key is
  // already in it.
  const manifest = keyringManifest(keyring);

  // Re-validated in the shape a deployment will actually boot with: `v2` as
  // `APP_KEY_NOW` and nothing staged. A plan that cannot boot is not a plan.
  createKeyring({
    now: input.next,
    manifest,
    ...(input.materials === undefined ? {} : { materials: input.materials }),
  });

  return {
    fromKeyId,
    toKeyId,
    env: { APP_KEY_NOW: formatKeySpec(nextKey), APP_KEY_NEXT: '' },
    manifest,
    changes: [
      `promote ${toKeyId} (writing since APP_KEY_NEXT was deployed)`,
      `keep ${fromKeyId} as decrypt-only`,
      `APP_KEY_NOW: ${fromKeyId} → ${toKeyId}`,
      'APP_KEY_NEXT: cleared',
      `manifest: ${String(manifest.length)} key(s) — deploy as TSIR_KEYRING_FILE`,
    ],
    appliedAt: input.nowIso,
  };
}

/** The id a spec names, without importing its material — for `--key` validation. */
export function activationTargetId(next: string | undefined): string | undefined {
  if (next === undefined || next.trim() === '') return undefined;
  try {
    return keyIdOf(next);
  } catch {
    return undefined;
  }
}

export interface RetirePlanInput {
  /** The key to retire. */
  readonly keyId: string;
  /** `TSIR_KEYRING_FILE`, already parsed: the deployed source of truth. */
  readonly manifest: readonly KeyringEntry[];
  /** Materials the manifest carries; the retired key's entry is dropped. */
  readonly materials?: Readonly<Record<string, string>> | undefined;
  /** Rows still naming this key, counted by the caller — never guessed here. */
  readonly remaining: number;
  /** The id that encrypts right now (ADR-0021: `_NEXT`, else `_NOW`). */
  readonly activeKeyId?: string | undefined;
  /** Accept rows that will become unreadable. Requires the CLI's typed confirmation. */
  readonly force?: boolean | undefined;
  /** ISO timestamp for the printed plan. */
  readonly nowIso?: string | undefined;
}

export interface RetirePlan {
  readonly keyId: string;
  readonly fromState: KeyState;
  /** Rows the caller said still reference the key; `0` means "proven empty". */
  readonly remaining: number;
  /** True when the plan goes ahead despite `remaining > 0`. */
  readonly forced: boolean;
  /** The manifest to deploy. The key is `retired` and keeps no material. */
  readonly manifest: readonly KeyringEntry[];
  readonly materials: Readonly<Record<string, string>>;
  /** Human lines, in the order they should be read. */
  readonly changes: readonly string[];
  readonly appliedAt: string | undefined;
}

/**
 * Computes a retirement without performing it (`VLT-017`).
 *
 * The order of the checks is the order of the mistakes operators actually make:
 * a key id that is not deployed, then the key that is currently encrypting, then
 * rows that still name the key. Each one is a refusal with a code, not a warning —
 * a retirement that "mostly" goes through leaves a deployment that cannot read its
 * own data, and the error is the only place that can be prevented.
 *
 * The one escape hatch is deliberate and loud: `force` plus a typed confirmation at
 * the CLI. The rows it strands throw `VLT_UNKNOWN_KEY` (never plaintext), which is
 * the failure the runbook documents in § 3.2.
 */
export function planRetire(input: RetirePlanInput): RetirePlan {
  const deployed = input.manifest.find((entry) => entry.id === input.keyId);
  if (deployed === undefined) {
    throw unknownKey(
      input.keyId,
      input.manifest.map((entry) => `${entry.id} (${entry.state})`),
    );
  }

  if (deployed.state === 'retired') {
    throw invalidKeyring(`key "${input.keyId}" is already retired`, { keyId: input.keyId });
  }

  // The writer is not merely "active" any more: with ADR-0021 the staged key is the
  // writer too, so both the manifest state and the caller's active id are checked.
  if (deployed.state === 'active' || input.keyId === input.activeKeyId) {
    throw keyStillActive(
      input.keyId,
      input.keyId === input.activeKeyId ? 'the active writer' : deployed.state,
    );
  }

  if (input.remaining > 0 && input.force !== true) {
    throw staleKey(input.keyId, input.remaining);
  }

  assertTransition(deployed.state, 'retired');

  // The state is the change; `createdAt` stays as it was, because when a key was
  // made is a fact and when it was retired is what the deployment manifest records.
  const manifest = input.manifest.map((entry) =>
    entry.id === input.keyId ? { ...entry, state: 'retired' as const } : entry,
  );
  const materials = { ...(input.materials ?? {}) };
  delete materials[input.keyId];

  const changes = [
    `key ${input.keyId}: ${deployed.state} → retired`,
    input.remaining > 0
      ? `${String(input.remaining)} row(s) still name key ${input.keyId} and will throw VLT_UNKNOWN_KEY — forced`
      : `no rows name key ${input.keyId} (counted, not assumed)`,
    `material for ${input.keyId}: ${Object.keys(input.materials ?? {}).includes(input.keyId) ? 'removed from the manifest' : 'not in the manifest'}`,
  ];

  return {
    keyId: input.keyId,
    fromState: deployed.state,
    remaining: input.remaining,
    forced: input.remaining > 0,
    manifest,
    materials,
    changes,
    appliedAt: input.nowIso,
  };
}
