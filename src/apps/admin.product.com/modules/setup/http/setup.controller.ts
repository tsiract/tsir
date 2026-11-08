/**
 * First-run installation.
 *
 * Before any user exists, the `/api/auth/setup` endpoint accepts an email and
 * password and creates the first super-admin. Once an `install_state` row
 * exists, the endpoint is locked (409) so a second install is impossible.
 */
import { Controller, Get, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { token } from '@tsir/container';

import { registry } from '../registry.ts';
import { type DrizzleDb } from '../../../database.ts';
import { installState, users } from '../../shared/schema.ts';
import { type AuthService } from '../../auth/index.ts';
import { type AuditService } from '../../shared/audit.ts';
import { type I18nService } from '../../i18n/index.ts';

export const SetupBody = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
});

export const setupControllerToken = token<SetupController>('SetupController');

@Controller(registry, '/api/auth/setup')
export class SetupController {
  constructor(
    private readonly drizzle: DrizzleDb,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly i18n: I18nService,
  ) {}

  @Get('/', { tags: ['setup'], operationId: 'setup.status' })
  async status(): Promise<unknown> {
    const row = await this.drizzle.select().from(installState);
    return { installed: row.length > 0 };
  }

  @Post('/', { body: SetupBody, status: 201, tags: ['setup'], operationId: 'setup.install' })
  async install({ body }: { body: z.infer<typeof SetupBody> }): Promise<Response> {
    const existing = await this.drizzle.select().from(installState);
    if (existing.length > 0) {
      return new Response(JSON.stringify({ error: 'already_installed' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }

    const passwordHash = await this.auth.hashPassword(body.password);
    const [user] = await this.drizzle
      .insert(users)
      .values({
        email: body.email.toLowerCase(),
        passwordHash,
        isSuperAdmin: true,
        emailVerified: true,
      })
      .returning();
    if (user === undefined) throw new Error('insert returned no row');

    await this.drizzle.insert(installState).values({ adminEmail: body.email.toLowerCase() });
    await this.i18n.seedBuiltInKeys();
    await this.audit.record({ actorId: user.id, action: 'setup.install', subject: body.email });

    return new Response(JSON.stringify({ ok: true, userId: user.id }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }
}
