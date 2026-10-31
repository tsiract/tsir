/**
 * The inlined-secret detector (`CFG-016`, `CFG_SECRET_INLINED`, used by `CFG-114`).
 *
 * A secret belongs in the environment (`{ fromEnv: 'NAME' }`), never in `tsir.js`. Two shapes are
 * caught: a 32-byte key written in base64 (the shape `openssl rand -base64 32` prints), and a URL
 * that carries a literal password (`postgres://user:secret@host`). A `${...}` placeholder is not a
 * secret. The value itself is never echoed: a finding names the key path and the rule.
 */

export type SecretKind = 'base64-32-byte-key' | 'url-password';

/** 32 bytes in base64 is 43 characters and one `=` of padding. */
const KEY_32_BYTES = /^[A-Za-z0-9+/]{43}=$/u;
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/iu;

export interface InlinedSecret {
  /** Where the literal sits: a dotted key path, or `line N` for a text scan. */
  readonly where: string;
  readonly kind: SecretKind;
}

/**
 * A key name that marks its value as a secret even without `.secret()` (`CFG-005`): `FOO_PASSWORD`,
 * `api_token`, `PRIVATE_KEY`, `DB_CREDENTIALS`. Matched on whole `_`-separated words, so
 * `PASSWORD_MIN_LENGTH` is not caught and `KEYBOARD` is not either.
 */
const SECRET_NAME =
  /(?:^|_)(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)$/iu;

export function isSecretName(key: string): boolean {
  return SECRET_NAME.test(key);
}

/** The kind of secret a string literal holds, or `undefined` when it holds none. */
export function secretKind(value: string): SecretKind | undefined {
  if (KEY_32_BYTES.test(value)) return 'base64-32-byte-key';
  const match = URL_PASSWORD.exec(value);
  if (match !== null && !/^\$\{.*\}$/u.test(match[1] ?? '')) return 'url-password';
  return undefined;
}

/** Every secret literal in a loaded configuration object, by key path. */
export function inlinedSecrets(value: unknown, path = ''): readonly InlinedSecret[] {
  if (typeof value === 'string') {
    const kind = secretKind(value);
    return kind === undefined ? [] : [{ where: path === '' ? '(root)' : path, kind }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index: number) =>
      inlinedSecrets(item, `${path}[${String(index)}]`),
    );
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      inlinedSecrets(item, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

/**
 * Every secret literal in source text, by line (`CFG-114`). Only quoted strings are read, so a
 * key that happens to sit in a comment is not reported.
 */
export function inlinedSecretsInText(text: string): readonly InlinedSecret[] {
  const found: InlinedSecret[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/gu)) {
      const kind = secretKind(match[2] ?? '');
      if (kind !== undefined) found.push({ where: `line ${String(index + 1)}`, kind });
    }
  });
  return found;
}
