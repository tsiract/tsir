/**
 * The decision.
 *
 * One shape, everywhere: `{ allowed: true }` or `{ allowed: false, reason }`. `@tsir/http` already
 * turns the false case into a 403 and audits both, so this package produces exactly that and adds
 * two fields that never reach a client:
 *
 * · **`source`** — which rule decided: `gate`, `policy`, `role`, `default`, or `unauthenticated`.
 * It is the answer to "why was this allowed?", which is the question a security review asks
 * and which a bare boolean cannot answer.
 * · **`reason`** — the sentence a 403 carries, and the line an audit record keeps.
 *
 * `source` is deliberately **not** forwarded to the client: telling an attacker that the reason was
 * "no role grants invoice.void" is free reconnaissance.
 */

export interface PolicyRequest<P = unknown> {
  readonly principal: { readonly subject: string; readonly data?: P | undefined } | undefined;
}

export type DecisionSource = 'gate' | 'policy' | 'role' | 'default' | 'unauthenticated';

export type Decision =
  | {
      readonly allowed: true;
      readonly source: DecisionSource;
      readonly reason?: string | undefined;
    }
  | {
      readonly allowed: false;
      readonly source: DecisionSource;
      readonly reason: string;
    };

/**
 * What a policy may return: the full `Decision`, or the bare `{ allowed }` that `@tsir/http` already
 * understands. `source` is filled in by the registry when a rule leaves it out, so a policy written
 * for http drops into this package unchanged.
 */
export type PolicyAnswer =
  | {
      readonly allowed: true;
      readonly source?: DecisionSource | undefined;
      readonly reason?: string | undefined;
    }
  | {
      readonly allowed: false;
      readonly source?: DecisionSource | undefined;
      readonly reason?: string | undefined;
    };

export function allow(source: DecisionSource, reason?: string): Decision {
  return { allowed: true, source, ...(reason === undefined ? {} : { reason }) };
}

export function deny(source: DecisionSource, reason: string): Decision {
  return { allowed: false, source, reason };
}

/** Structural check for a decision a user-written policy returned. Fails closed, never open. */
export function isDecision(value: unknown): value is { readonly allowed: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { allowed?: unknown }).allowed === 'boolean';
}
