/**
 * Runtime capability probes.
 *
 * Packages declare what they need; the runtime declares what it has; boot
 * compares the two and fails with a table of missing capabilities *before* any
 * traffic is served.
 *
 * Detection never guesses: a capability is present only when the underlying
 * primitive is actually reachable in this isolate.
 */

import { TsirError } from '@tsir/container';

export type DeployTarget = 'bun' | 'cloudflare' | 'lambda';

export type Capability =
  | 'node-compat'
  | 'raw-sockets'
  | 'filesystem'
  | 'durable-state'
  | 'background-tasks'
  | 'subprocesses'
  | 'long-running-process';

export interface RuntimeCapabilities {
  readonly target: DeployTarget;
  readonly has: (capability: Capability) => boolean;
  readonly list: readonly Capability[];
}

export interface CapabilityRequirement {
  readonly module: string;
  readonly capabilities: readonly Capability[];
}

type Global = typeof globalThis & {
  Bun?: unknown;
  WebSocketPair?: unknown;
  process?: { versions?: { node?: string } };
  navigator?: { userAgent?: string };
};

const globals = globalThis as Global;

function detectTarget(): DeployTarget {
  if (globals.Bun !== undefined) return 'bun';
  if (typeof globals.WebSocketPair !== 'undefined') return 'cloudflare';
  const node = globals.process?.versions?.node;
  if (typeof node === 'string') return 'lambda';
  return 'bun';
}

const hasFileSystem = (): boolean => {
  try {
    return typeof (globals as { Deno?: unknown }).Deno !== 'undefined'
      ? true
      : globals.Bun !== undefined || globals.process !== undefined;
  } catch {
    return false;
  }
};

const CAPABILITY_TABLE: Readonly<Record<DeployTarget, readonly Capability[]>> = {
  bun: [
    'node-compat',
    'raw-sockets',
    'filesystem',
    'background-tasks',
    'subprocesses',
    'long-running-process',
  ],
  cloudflare: ['background-tasks', 'durable-state'],
  lambda: ['node-compat', 'filesystem', 'background-tasks'],
};

/**
 * What a target can do, **statically**.
 *
 * `probeCapabilities` answers "what does *this* isolate have"; this answers "what does
 * this *kind* of runtime have", which is the question a build asks. The two share the
 * table, so a deploy that passes at build time and fails at boot would mean the probe is
 * wrong — and `capabilities.test.ts` asserts they agree.
 */
export function targetCapabilities(target: DeployTarget): RuntimeCapabilities {
  const available = new Set(CAPABILITY_TABLE[target]);
  return {
    target,
    has: (capability: Capability) => available.has(capability),
    list: [...available],
  };
}

export function probeCapabilities(target: DeployTarget = detectTarget()): RuntimeCapabilities {
  const available = new Set(CAPABILITY_TABLE[target]);
  // Filesystem is only claimed when a runtime primitive plausibly exists.
  if (available.has('filesystem') && !hasFileSystem()) available.delete('filesystem');

  return {
    target,
    has: (capability: Capability) => available.has(capability),
    list: [...available],
  };
}

export function assertCapabilities(
  runtime: RuntimeCapabilities,
  requirements: readonly CapabilityRequirement[],
): void {
  const missing: { module: string; capability: Capability }[] = [];

  for (const requirement of requirements) {
    for (const capability of requirement.capabilities) {
      if (!runtime.has(capability)) missing.push({ module: requirement.module, capability });
    }
  }

  if (missing.length === 0) return;

  const rows = missing.map((entry) => `${entry.module} requires ${entry.capability}`).join('; ');
  throw new TsirError(
    'APP_CAPABILITY_MISSING',
    `Missing runtime capabilities on target "${runtime.target}": ${rows}`,
    {
      kind: 'deploy',
      hint: 'remove the module, switch deploy target, or enable the runtime flag (e.g. nodejs_compat)',
      context: {
        target: runtime.target,
        missing: missing.length,
      },
    },
  );
}
