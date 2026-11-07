/**
 * Email template management endpoints.
 *
 * Templates stored in the database can be edited through the UI; the built-in
 * templates (like `reset-password`) are seeded from code and overridable here.
 */
import { Controller, Delete, Get, Patch, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import { type DrizzleDb } from '../../../database.ts';
import { emailTemplates } from '../../shared/schema.ts';
import { eq } from 'drizzle-orm';
import { type AuditService } from '../../shared/audit.ts';
import type { AppPrincipal } from '../../auth/index.ts';

export const TemplateBody = z.object({
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(300),
  html: z.string().optional(),
  text: z.string().min(1),
});

export const TemplateUpdate = z.object({
  subject: z.string().min(1).max(300).optional(),
  html: z.string().optional().nullable(),
  text: z.string().min(1).optional(),
});

export const mailControllerToken = token<MailController>('MailController');

@Controller(registry, '/api/email-templates')
export class MailController {
  constructor(
    private readonly drizzle: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  @Get('/', {
    guards: ['session', 'superAdmin'],
    tags: ['mail'],
    operationId: 'mail.listTemplates',
  })
  async list(): Promise<unknown> {
    const rows = await this.drizzle.select().from(emailTemplates);
    return { data: rows };
  }

  @Get('/:name', {
    guards: ['session', 'superAdmin'],
    tags: ['mail'],
    operationId: 'mail.getTemplate',
  })
  async get({ params }: { params: { name: string } }): Promise<unknown> {
    const rows = await this.drizzle
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.name, params.name));
    const row = rows[0];
    if (row === undefined) return new Response(null, { status: 404 });
    return row;
  }

  @Post('/', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: TemplateBody,
    status: 201,
    tags: ['mail'],
    operationId: 'mail.createTemplate',
  })
  async create({
    body,
    principal,
  }: {
    body: z.infer<typeof TemplateBody>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const [row] = await this.drizzle.insert(emailTemplates).values(body).returning();
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'mail.create_template',
      subject: body.name,
    });
    return row;
  }

  @Patch('/:name', {
    guards: ['session', 'superAdmin'],
    principal: true,
    body: TemplateUpdate,
    tags: ['mail'],
    operationId: 'mail.updateTemplate',
  })
  async update({
    params,
    body,
    principal,
  }: {
    params: { name: string };
    body: z.infer<typeof TemplateUpdate>;
    principal: AppPrincipal;
  }): Promise<unknown> {
    const [row] = await this.drizzle
      .update(emailTemplates)
      .set(body)
      .where(eq(emailTemplates.name, params.name))
      .returning();
    if (row === undefined) return new Response(null, { status: 404 });
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'mail.update_template',
      subject: params.name,
    });
    return row;
  }

  @Delete('/:name', {
    guards: ['session', 'superAdmin'],
    principal: true,
    status: 204,
    tags: ['mail'],
    operationId: 'mail.deleteTemplate',
  })
  async remove({
    params,
    principal,
  }: {
    params: { name: string };
    principal: AppPrincipal;
  }): Promise<void> {
    await this.drizzle.delete(emailTemplates).where(eq(emailTemplates.name, params.name));
    await this.audit.record({
      actorId: principal.data.userId,
      action: 'mail.delete_template',
      subject: params.name,
    });
  }
}
