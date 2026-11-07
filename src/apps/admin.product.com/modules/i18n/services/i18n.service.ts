/**
 * The i18n service.
 *
 * Keys are stored in `i18n_keys`; translations are per-locale rows in
 * `i18n_translations`. The default locale (`en`) is the fallback: a key without
 * an `en` translation returns its own key name, so a missing translation is
 * visible rather than blank.
 */
import { token } from '@tsir/container';
import { type DrizzleDb } from '../../../database.ts';
import { i18nKeys, i18nTranslations } from '../../shared/schema.ts';
import { and, eq } from 'drizzle-orm';

/** The built-in English key dictionary — seeded at install and editable through the UI. */
export const DEFAULT_LOCALE = 'en';

export const builtInKeys: Record<string, string> = {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.create': 'Create',
  'common.search': 'Search',
  'common.loading': 'Loading…',
  'common.actions': 'Actions',
  'auth.login': 'Sign in',
  'auth.logout': 'Sign out',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.forgot_password': 'Forgot password?',
  'auth.reset_password': 'Reset password',
  'auth.install': 'Install admin',
  'users.title': 'Users',
  'users.create': 'Create user',
  'roles.title': 'Roles',
  'roles.create': 'Create role',
  'permissions.title': 'Permissions',
  'groups.title': 'Groups',
  'groups.create': 'Create group',
  'i18n.title': 'Translations',
  'mail.title': 'Email templates',
};

export const i18nServiceToken = token<I18nService>('I18nService');

export class I18nService {
  constructor(private readonly drizzle: DrizzleDb) {}

  /** Translate a key for a locale, falling back to English then the key itself. */
  async t(key: string, locale = DEFAULT_LOCALE): Promise<string> {
    const keyRow = await this.drizzle
      .select({ id: i18nKeys.id })
      .from(i18nKeys)
      .where(eq(i18nKeys.key, key));
    if (keyRow[0] === undefined) return key;

    const rows = await this.drizzle
      .select({ locale: i18nTranslations.locale, value: i18nTranslations.value })
      .from(i18nTranslations)
      .where(eq(i18nTranslations.keyId, keyRow[0].id));

    const byLocale = new Map(rows.map((r) => [r.locale, r.value]));
    return byLocale.get(locale) ?? byLocale.get(DEFAULT_LOCALE) ?? key;
  }

  /** Return the full dictionary for a locale (English merged with overrides). */
  async dictionary(locale = DEFAULT_LOCALE): Promise<Record<string, string>> {
    const keys = await this.drizzle.select().from(i18nKeys);
    const translations = await this.drizzle.select().from(i18nTranslations);
    const byKeyId = new Map<string, Map<string, string>>();
    for (const tr of translations) {
      if (!byKeyId.has(tr.keyId)) byKeyId.set(tr.keyId, new Map());
      const localeMap = byKeyId.get(tr.keyId);
      if (localeMap !== undefined) localeMap.set(tr.locale, tr.value);
    }
    const dict: Record<string, string> = {};
    for (const k of keys) {
      const map = byKeyId.get(k.id);
      dict[k.key] = map?.get(locale) ?? map?.get(DEFAULT_LOCALE) ?? k.key;
    }
    return dict;
  }

  /** Seed the built-in English keys if they are missing. Called at first install. */
  async seedBuiltInKeys(): Promise<void> {
    for (const [key, value] of Object.entries(builtInKeys)) {
      const existing = await this.drizzle
        .select({ id: i18nKeys.id })
        .from(i18nKeys)
        .where(eq(i18nKeys.key, key));
      if (existing[0] !== undefined) continue;
      const [row] = await this.drizzle
        .insert(i18nKeys)
        .values({ key, namespace: 'common' })
        .returning();
      if (row === undefined) continue;
      await this.drizzle
        .insert(i18nTranslations)
        .values({ keyId: row.id, locale: DEFAULT_LOCALE, value });
    }
  }
}

void and;
