/**
 * i18n endpoints: list keys, get/set translations per locale, and fetch the
 * dictionary for the SPA.
 */
import { Controller, Delete, Get, Patch, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { and, eq } from 'drizzle-orm';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import { type DrizzleDb } from '../../../database.ts';
import { i18nKeys, i18nTranslations } from '../../shared/schema.ts';
import { type I18nService, DEFAULT_LOCALE } from '../services/i18n.service.ts';
import { type AuditService } from '../../shared/audit.ts';
import type { AppPrincipal } from '../../auth/index.ts';

export const CreateKey = z.object({
  key: z.string().min(1).max(200),
  namespace: z.string().min(1).max(120).default('common'),
  value: z.string().min(1).optional(),
  locale: z.string().min(2).max(10).default(DEFAULT_LOCALE),
});

export const UpdateTranslation = z.object({
  value: z.string().min(1),
});

export const LocaleQuery = z.object({ locale: z.string().min(2).max(10).default(DEFAULT_LOCALE) });

export const i18nControllerToken = token<I18nController>('I18nController');

@Controller(registry, '/api/i18n')
export class I18nController {
  constructor(
    private readonly drizzle: DrizzleDb,
    private readonly i18n: I18nService,
    private readonly audit: AuditService,
  ) {}

  @Get('/dictionary', { tags: ['i18n'], operationId: 'i18n.dictionary' })
  async dictionary({ query }: { query?: { locale?: string } }): Promise<unknown> {
    const locale = query?.locale ?? DEFAULT_LOCALE;
    return { locale, dictionary: await this.i18n.dictionary(locale) };
  }

  @Get('/keys', { guards: ['session', 'superAdmin'], tags: ['i18n'], operationId: 'i18n.listKeys' })
  async listKeys(): Promise<unknown> {
    const rows = await this.drizzle
      .select({
        id: i18nKeys.id,
        key: i18nKeys.key,
        namespace: i18nKeys.namespace,
      })
      .from(i18nKeys);
    return { data: rows };
  }

  @Get('/keys/:id/translations', {
    guards: ['session', 'superAdmin'],
    tags: ['i18n'],
    operationId: 'i18n.listTranslations',
  })
  async listTranslations({ params }: { params: { id: string } }): Promise<unknown> {
    const rows = await this.drizzle
      .select()
      .from(i18nTranslations)
      .where(eq(i18nTranslations.keyId, params.id));
    return { data: rows };
  }

  @Post('/keys', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: CreateKey,
    status: 201,
    tags: ['i18n'],
    operationId: 'i18n.createKey',
  })
  async createKey({
    body,
    principal,
  }: {
    body: z.infer<typeof CreateKey>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const [key] = await this.drizzle
      .insert(i18nKeys)
      .values({ key: body.key, namespace: body.namespace })
      .returning();
    if (key === undefined) throw new Error('insert returned no row');
    if (body.value) {
      await this.drizzle
        .insert(i18nTranslations)
        .values({ keyId: key.id, locale: body.locale, value: body.value });
    }
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'i18n.create_key',
      subject: body.key,
    });
    return key;
  }

  @Patch('/keys/:id/translations/:locale', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: UpdateTranslation,
    tags: ['i18n'],
    operationId: 'i18n.updateTranslation',
  })
  async updateTranslation({
    params,
    body,
    principal,
  }: {
    params: { id: string; locale: string };
    body: z.infer<typeof UpdateTranslation>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const existing = await this.drizzle
      .select()
      .from(i18nTranslations)
      .where(
        and(eq(i18nTranslations.keyId, params.id), eq(i18nTranslations.locale, params.locale)),
      );
    if (existing[0] === undefined) {
      const [row] = await this.drizzle
        .insert(i18nTranslations)
        .values({ keyId: params.id, locale: params.locale, value: body.value })
        .returning();
      await this.audit.record({
        actorId: principal.data.userId,
        action: 'i18n.create_translation',
        subject: params.id,
      });
      return row;
    }
    const [row] = await this.drizzle
      .update(i18nTranslations)
      .set({ value: body.value })
      .where(and(eq(i18nTranslations.keyId, params.id), eq(i18nTranslations.locale, params.locale)))
      .returning();
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'i18n.update_translation',
      subject: params.id,
    });
    return row;
  }

  @Delete('/keys/:id', {
    guards: ['session', 'superAdmin'],
    principal: true,
    status: 204,
    tags: ['i18n'],
    operationId: 'i18n.deleteKey',
  })
  async deleteKey({
    params,
    principal,
  }: {
    params: { id: string };
    principal: AppPrincipal;
  }): Promise<void> {
    await this.drizzle.delete(i18nKeys).where(eq(i18nKeys.id, params.id));
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'i18n.delete_key',
      subject: params.id,
    });
  }

  @Post('/seed', {
    guards: ['session', 'superAdmin'],
    principal: true,
    status: 201,
    tags: ['i18n'],
    operationId: 'i18n.seed',
  })
  async seed({ principal }: { principal: AppPrincipal }): Promise<unknown> {
    await this.i18n.seedBuiltInKeys();
    await this.audit.record({ actorId: principal.data.userId, action: 'i18n.seed' });
    return { ok: true };
  }
}
