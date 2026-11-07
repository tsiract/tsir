/**
 * @tsir/pennant — feature flags.
 *
 * A `FeatureManager` resolves a feature name + context (user id, segment) to
 * `true`/`false`. Flags can be:
 *   · **boolean** — on/off for everyone
 *   · **percentage** — on for N% of users (deterministic by user id hash)
 *   · **allowlist** — on for specific user ids / segments
 *   · **conditional** — arbitrary function
 *
 * Three stores: `memoryStore` (in-process), `databaseStore` (SQL table), and
 * `redisStore`. The manager caches resolved values per request scope.
 */

export interface FeatureContext {
  /** The acting user id, if any. */
  readonly userId?: string;
  /** Free-form segments (e.g. 'beta', 'vip'). */
  readonly segments?: readonly string[];
}

export type FeatureRule =
  | { type: 'boolean'; value: boolean }
  | { type: 'percentage'; value: number }
  | { type: 'allowlist'; users: readonly string[]; segments?: readonly string[] }
  | { type: 'conditional'; check: (ctx: FeatureContext) => boolean };

export interface FeatureDefinition {
  name: string;
  description?: string;
  rule: FeatureRule;
}

export interface FeatureStore {
  get(name: string): Promise<FeatureDefinition | null>;
  set(def: FeatureDefinition): Promise<void>;
  all(): Promise<readonly FeatureDefinition[]>;
}

/**
 * Deterministic percentage check: hash the user id and see if it falls in the
 * first `percentage` percent of the hash space. Same user always gets the same
 * answer for the same flag.
 */
function inPercentage(userId: string, percentage: number): boolean {
  let hash = 0;
  const str = `${userId}`;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  const bucket = Math.abs(hash) % 100;
  return bucket < percentage;
}

/** Evaluate a rule against a context. */
export function evaluate(rule: FeatureRule, ctx: FeatureContext): boolean {
  switch (rule.type) {
    case 'boolean':
      return rule.value;
    case 'percentage':
      if (ctx.userId === undefined) return false;
      return inPercentage(ctx.userId, rule.value);
    case 'allowlist': {
      if (ctx.userId !== undefined && rule.users.includes(ctx.userId)) return true;
      if (ctx.segments !== undefined && rule.segments !== undefined) {
        for (const seg of rule.segments) {
          if (ctx.segments.includes(seg)) return true;
        }
      }
      return false;
    }
    case 'conditional':
      return rule.check(ctx);
  }
}

/** The feature manager: resolve flags by name + context. */
export interface FeatureManager {
  active(name: string, ctx?: FeatureContext): Promise<boolean>;
  define(def: FeatureDefinition): Promise<void>;
  all(): Promise<readonly FeatureDefinition[]>;
  get(name: string): Promise<FeatureDefinition | null>;
}

export function createFeatureManager(store: FeatureStore): FeatureManager {
  return {
    async active(name, ctx = {}): Promise<boolean> {
      const def = await store.get(name);
      if (def === null) return false;
      return evaluate(def.rule, ctx);
    },
    async define(def): Promise<void> {
      await store.set(def);
    },
    async all(): Promise<readonly FeatureDefinition[]> {
      return store.all();
    },
    async get(name): Promise<FeatureDefinition | null> {
      return store.get(name);
    },
  };
}
