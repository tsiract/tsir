/**
 * `Redacted<T>` — a value that cannot leak by accident.
 *
 * The wrapper is deliberately hostile: `toString`, `toJSON`, and template
 * coercion all produce a mask, so a secret interpolated into a log line or a
 * `JSON.stringify` of a config object cannot expose plaintext. Reading the
 * value requires calling `reveal()`, which is visible in code review and can be
 * instrumented (see `onReveal`).
 */

const MASK = '[redacted]';

export interface RedactedOptions {
  /** Called every time the value is unwrapped. Used to trace accidental reveals. */
  readonly onReveal?: (label: string) => void;
}

const revealHooks = new WeakMap<Redacted<unknown>, RedactedOptions>();

export class Redacted<T> {
  readonly #value: T;
  readonly #label: string;

  constructor(value: T, label: string, options: RedactedOptions = {}) {
    this.#value = value;
    this.#label = label;
    revealHooks.set(this, options);
    Object.freeze(this);
  }

  reveal(): T {
    revealHooks.get(this)?.onReveal?.(this.#label);
    return this.#value;
  }

  get label(): string {
    return this.#label;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  /** Enables `String(value)`, template literals, and `value + ''` to yield the mask. */
  [Symbol.toPrimitive](): string {
    return MASK;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `${MASK}<${this.#label}>`;
  }
}

export function isRedacted(value: unknown): value is Redacted<unknown> {
  return value instanceof Redacted;
}

export function redact<T>(value: T, label: string, options: RedactedOptions = {}): Redacted<T> {
  return new Redacted(value, label, options);
}
