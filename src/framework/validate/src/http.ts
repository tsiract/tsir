/**
 * HTTP-shaped schemas.
 *
 * Deliberately a **subpath** (`@tsir/validate/http`) rather than part of the main
 * entry: these are Zod instances created at module scope, and a bundler must keep
 * a module-scope initializer. Exporting them from `@tsir/validate` itself would
 * add their weight to every consumer that only wants `validate()` — including the
 * `config-only` bundle, which is measured against a budget in `verify-dist`.
 *
 * Conversion rules are explicit, never guessed:
 *   · `IntParam` accepts `/^-?\d+$/` only — not `"1e3"`, not `" 3"`, not `"0x10"`
 *   · `PageQuery` treats a missing value as absent, then applies its default
 *   · nothing here accepts an empty string as a number
 */

import { z } from 'zod';

const INTEGER = /^-?\d+$/;
const NON_NEGATIVE = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const safeInteger = (value: number): boolean => Number.isSafeInteger(value);

/** An integer path parameter. `"42"` → `42`; `"4.2"`, `"1e3"` and `" 3"` are rejected. */
export const IntParam = z
  .string()
  .regex(INTEGER, 'Expected an integer')
  .transform((value) => Number(value)) // coercion-ok: the explicit declaration — regex-guarded above
  .refine(safeInteger, 'Integer is outside the safe range');

/** A non-negative integer: identifiers, counts, and anything that cannot be negative. */
export const UintParam = z
  .string()
  .regex(NON_NEGATIVE, 'Expected a non-negative integer')
  .transform((value) => Number(value)) // coercion-ok: the explicit declaration — regex-guarded above
  .refine(safeInteger, 'Integer is outside the safe range');

/** RFC 4122 shape; the version nibble is not enforced on input. */
export const UuidParam = z.string().regex(UUID, 'Expected a UUID');

/** `lowercase-with-single-hyphens`. */
export const SlugParam = z.string().regex(SLUG, 'Expected a lowercase slug');

/** `YYYY-MM-DD`, kept as a string: a calendar date has no timezone and no time. */
export const DateParam = z.string().regex(CALENDAR_DATE, 'Expected YYYY-MM-DD');

export interface PageQueryOptions {
  /** Defaults to 1. */
  readonly defaultPage?: number;
  /** Defaults to 20. */
  readonly defaultPerPage?: number;
  /** Hard ceiling a client cannot exceed. Defaults to 100. */
  readonly maxPerPage?: number;
}

function pageNumber(maximum: number) {
  return z
    .string()
    .regex(NON_NEGATIVE, 'Expected a positive integer')
    .transform((value) => Number(value)) // coercion-ok: regex-guarded above
    .refine((value) => value >= 1 && value <= maximum, `Expected a value between 1 and ${maximum}`);
}

/**
 * `?page=&perPage=` with bounded values.
 *
 * The cap is enforced here rather than in the handler so no route can accept
 * `perPage=1000000` and read a table into memory.
 */
export function PageQuery(
  options: PageQueryOptions = {},
): z.ZodType<{ page: number; perPage: number }> {
  const defaultPage = options.defaultPage ?? 1;
  const defaultPerPage = options.defaultPerPage ?? 20;
  const maximum = options.maxPerPage ?? 100;

  return z
    .object({
      page: pageNumber(Number.MAX_SAFE_INTEGER).optional(),
      perPage: pageNumber(maximum).optional(),
    })
    .transform((value) => ({
      page: value.page ?? defaultPage,
      perPage: value.perPage ?? defaultPerPage,
    }));
}

export type SortDirection = 'asc' | 'desc';

export interface SortClause<F extends string = string> {
  readonly field: F;
  readonly direction: SortDirection;
}

/**
 * `?sort=-createdAt,email` → `[{ field: 'createdAt', direction: 'desc' }, …]`.
 *
 * Unknown fields are rejected when `allowed` is supplied: a sort parameter that
 * reaches the database unchecked is an index-scan denial of service.
 */
export function SortQuery<const F extends readonly string[]>(
  allowed: F,
): z.ZodType<SortClause<F[number]>[]> {
  const fields = new Set<string>(allowed);
  return z
    .string()
    .optional()
    .transform((value, ctx): SortClause<F[number]>[] => {
      if (value === undefined || value.trim() === '') return [];
      const clauses: SortClause<F[number]>[] = [];
      for (const raw of value.split(',')) {
        const trimmed = raw.trim();
        const direction: SortDirection = trimmed.startsWith('-') ? 'desc' : 'asc';
        const field = direction === 'desc' ? trimmed.slice(1) : trimmed;
        if (!fields.has(field)) {
          ctx.addIssue({ code: 'custom', message: `Cannot sort by "${field}"` });
          continue;
        }
        clauses.push({ field, direction });
      }
      return clauses;
    });
}

export interface FileConstraints {
  /** Declared media types the field accepts, e.g. `['image/png', 'image/jpeg']`. */
  readonly mimeTypes?: readonly string[];
  /** Maximum size of this file, in bytes. */
  readonly maxBytes?: number;
  /** Minimum size, in bytes. Defaults to non-empty. */
  readonly minBytes?: number;
}

/**
 * A single uploaded file, with its constraints declared next to the schema.
 *
 * The declared `type` is checked here; whether the *bytes* agree with it is
 * checked while the multipart body is parsed (`@tsir/http`), because that is the
 * only place the stream is available and a mismatch is a parse-time rejection,
 * not a validation issue. Both produce a client error — 422 — but only the parse
 * path can be trusted, since `File.type` is attacker-controlled.
 */
export function FileField(constraints: FileConstraints = {}): z.ZodType<File> {
  let schema = z.file();

  const minimum = constraints.minBytes ?? 1;
  if (minimum > 1) schema = schema.min(minimum, `Expected a file of at least ${minimum} bytes`);
  else schema = schema.min(1, 'Expected a non-empty file');

  if (constraints.maxBytes !== undefined) {
    schema = schema.max(
      constraints.maxBytes,
      `Expected a file of at most ${constraints.maxBytes} bytes`,
    );
  }
  if (constraints.mimeTypes !== undefined && constraints.mimeTypes.length > 0) {
    schema = schema.mime(
      [...constraints.mimeTypes],
      `Expected ${constraints.mimeTypes.join(' or ')}`,
    );
  }

  return schema;
}

/** Repeated files under one field name, bounded. */
export function FileList(
  options: { readonly max?: number } & FileConstraints = {},
): z.ZodType<File[]> {
  const max = options.max ?? 10;
  const single = FileField(options);
  return z
    .array(single)
    .min(1, 'Expected at least one file')
    .max(max, `Expected at most ${max} files`);
}

export interface DateRangeOptions {
  /** Parameter names. Defaults to `from`/`to`. */
  readonly fromKey?: string;
  readonly toKey?: string;
  /** Reject a range wider than this many days. */
  readonly maxDays?: number;
}

/**
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` as a half-open interval `[from, to)`.
 *
 * Calendar dates, not timestamps: a query filter that silently depends on the
 * server's timezone is a bug that only appears near midnight in one region.
 * `to` is exclusive so that consecutive ranges tile without overlap, which is
 * what every pagination-by-date implementation expects.
 */
export function DateRange(options: DateRangeOptions = {}): z.ZodType<{ from?: Date; to?: Date }> {
  const fromKey = options.fromKey ?? 'from';
  const toKey = options.toKey ?? 'to';
  const DAY_MS = 86_400_000;

  return z
    .object({
      [fromKey]: z.string().regex(CALENDAR_DATE, 'Expected YYYY-MM-DD').optional(),
      [toKey]: z.string().regex(CALENDAR_DATE, 'Expected YYYY-MM-DD').optional(),
    })
    .transform((value, ctx): { from?: Date; to?: Date } => {
      const raw = value as Record<string, string | undefined>;
      const parse = (text: string | undefined): Date | undefined => {
        if (text === undefined) return undefined;
        // `new Date('2024-02-30')` rolls over to March; checking the round-trip
        // is the only way to reject a date that does not exist.
        const date = new Date(`${text}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
          ctx.addIssue({ code: 'custom', message: `"${text}" is not a real calendar date` });
          return undefined;
        }
        return date;
      };

      const from = parse(raw[fromKey]);
      const to = parse(raw[toKey]);

      if (from !== undefined && to !== undefined) {
        if (to.getTime() < from.getTime()) {
          ctx.addIssue({ code: 'custom', message: `"${toKey}" must not precede "${fromKey}"` });
        } else if (
          options.maxDays !== undefined &&
          (to.getTime() - from.getTime()) / DAY_MS > options.maxDays
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `range must not exceed ${String(options.maxDays)} days`,
          });
        }
      }

      return {
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      };
    });
}
