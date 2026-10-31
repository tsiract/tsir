/**
 * Type-level tests (CTN-013, TST-009).
 *
 * These lines are compiled, not executed. A `@ts-expect-error` that stops
 * failing is itself a compile error, so the guarantees below cannot silently
 * rot when the implementation changes.
 */

import { classProvider, factoryProvider, token, type Token } from '../src/index.ts';

class Connection {
  constructor(readonly dsn: string) {}
}

const ConnectionToken = token<Connection>('Connection');
const DsnToken = token<string>('Dsn');
const PortToken = token<number>('Port');

// ── inject arrays must match the constructor exactly ───────────────────────

classProvider(ConnectionToken, Connection, [DsnToken]);

// @ts-expect-error — missing an argument in `inject`
classProvider(ConnectionToken, Connection, []);

// @ts-expect-error — one argument too many
classProvider(ConnectionToken, Connection, [DsnToken, PortToken]);

// @ts-expect-error — wrong token type for the parameter
classProvider(ConnectionToken, Connection, [PortToken]);

factoryProvider(DsnToken, (port: number) => `postgres://localhost:${String(port)}`, [PortToken]);

// @ts-expect-error — factory parameter type drift
factoryProvider(DsnToken, (port: number) => String(port), [DsnToken]);

// ── tokens are not interchangeable across types ────────────────────────────

declare const stringToken: Token<string>;
// @ts-expect-error — Token<string> is not Token<number>
const numberToken: Token<number> = stringToken;
void numberToken;

// ── tokens widen covariantly (so Token<T> works where Token<unknown> is asked) ──

const widened: Token<unknown> = DsnToken;
void widened;

// ── provider implementations are not part of the public shape ──────────────

const provider = classProvider(ConnectionToken, Connection, [DsnToken]);
// @ts-expect-error — `use` is not exposed on the public provider type
provider.use;
void provider;
