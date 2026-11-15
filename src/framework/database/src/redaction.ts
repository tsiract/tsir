/**
 * Telling a value from an identifier, without a SQL parser (`DX-016`).
 *
 * `scrubSql` replaces quoted *literals* with `?`. That is the right default and it is not enough:
 *
 * ```sql
 * insert into users (email, password_hash) values (?, ?)
 * update users set email = lower(?)   -- a function, not a literal
 * select * from users where phone = 5551234         -- a bare number is not quoted
 * ```
 *
 * The first line is safe because the values are parameters. The next two are safe only because the
 * *column* is a signal: `email` and `phone` were named in the statement, and a statement that names
 * them is a statement about personal data whatever the placeholder count says. The log keeps the
 * statement and drops the value wherever a sensitive column is being written or compared.
 *
 * The rule is deliberately conservative in one direction: it would rather print `email = ?` than
 * `email = 'ada@example.com'`, and it never tries to parse expressions. A redactor that can be
 * wrong about escaping is worse than one that over-redacts — and a redactor that only knows about
 * quotes is the one that leaks, because the interesting columns are rarely written as constants.
 */

/**
 * Column names whose values never reach a log.
 *
 * Matched case-insensitively against the identifier that precedes a comparison or appears in an
 * insert/update column list. Suffix patterns (`password_hash`, `card_number`) are covered by the
 * prefixes on purpose: a schema adds `password_reset_token` far more often than it invents a new
 * kind of secret.
 */
export const SENSITIVE_COLUMNS: readonly string[] = [
  'email',
  'password',
  'hash',
  'secret',
  'token',
  'authorization',
  'cookie',
  'phone',
  'ssn',
  'card',
  'otp',
  'pin',
  'salt',
  'api_key',
  'apikey',
  'private_key',
  'session',
  'iban',
  'address',
  'birth',
  'passport',
  'licence',
  'license',
];

/**
 * A column is sensitive when one of its **name segments** is a sensitive word.
 *
 * Segments, not substrings: `pin` is sensitive and `pinned` is not, `card` is sensitive and
 * `discarded` is not. Matching a substring anywhere in the identifier redacts half a schema's
 * columns and the log stops being worth opening — which is a redactor people switch off, and then
 * the leak is back.
 */
const SENSITIVE_SEGMENT = new RegExp(`^(?:${SENSITIVE_COLUMNS.join('|')})$`, 'iu');

/** An identifier, optionally schema- and table-qualified, optionally quoted by either dialect. */
const IDENTIFIER = String.raw`(?:"[\w$]+"|` + '`[\\w$]+`' + String.raw`|[A-Za-z_][\w$]*)`;
/** `email`, `users.email`, `"users"."email"`. */
const COLUMN = String.raw`(?:${IDENTIFIER}\s*\.\s*)*${IDENTIFIER}`;

/**
 * What can sit on the right of a comparison.
 *
 * Ordered longest-first: a function call has to be tried before the bare identifier it starts with,
 * or `lower(?)` is rewritten to `?` and leaves `(?)` behind.
 */
const VALUE = String.raw`(?:\([^()]*\)|[A-Za-z_][\w$]*\s*\([^()]*\)|\$\d+|\?|[-+]?\d+(?:\.\d+)?|[A-Za-z_][\w$]*)`;
/** `email = ?`, `email <> $1`, `users.phone is not null` — the left side is what decides. */
const COMPARISON = new RegExp(
  String.raw`(${COLUMN})\s*(=|<>|!=|<=|>=|<|>|\blike\b|\bilike\b|\bin\b|\bis\b)\s*(${VALUE})`,
  'giu',
);

/** The bare column name out of `"users"."email"`. */
export function columnName(identifier: string): string {
  const parts = identifier.split('.');
  return (parts[parts.length - 1] ?? identifier).replace(/["`]/gu, '').trim().toLowerCase();
}

/** `password_hash` → `password`, `hash`; `"users"."api_key"` → `api`, `key`. */
function segments(identifier: string): readonly string[] {
  return columnName(identifier)
    .split(/[_.\s]+/u)
    .filter((segment) => segment.length > 0);
}

export function isSensitiveColumn(identifier: string): boolean {
  const name = columnName(identifier);
  if (SENSITIVE_SEGMENT.test(name)) return true;
  return segments(identifier).some((segment) => SENSITIVE_SEGMENT.test(segment));
}

/**
 * Replace the value of every comparison whose column is sensitive.
 *
 * Keeps the column and the operator — `email = ?` is the useful shape, `? ? ?` is not — and drops
 * the value whether it was a parameter, a number, a function call or a bare identifier. Nothing
 * here re-derives what the value *was*.
 */
function redactComparisons(sql: string): string {
  return sql.replace(COMPARISON, (whole: string, column: string, operator: string) => {
    if (!isSensitiveColumn(column)) return whole;
    const op = operator.trim().toLowerCase();
    // `is null` / `is not null` carry no value; rewriting them would change what the statement says.
    if (op === 'is') return whole;
    return `${column} ${operator.trim()} ?`;
  });
}

/**
 * Statement text for a log or a telemetry row: no literals, no sensitive values, no whitespace.
 *
 * Order matters. Literals go first, so a quoted string cannot be mistaken for an identifier and
 * then be "redacted" into something that looks like a column. An `insert … values ('…')` needs no
 * column-list rule: the values are literals the first pass already removed.
 */
export function redactSql(sql: string): string {
  const collapsed = sql.replace(/\s+/gu, ' ').trim();
  const withoutLiterals = collapsed.replace(/'(?:[^']|'')*'/gu, '?');
  return redactComparisons(withoutLiterals);
}
