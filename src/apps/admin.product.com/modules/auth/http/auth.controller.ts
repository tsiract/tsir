/**
 * Authentication endpoints: login (with captcha), logout, forgot-password,
 * reset-password, and the current principal.
 *
 * Login refuses before it tells the client anything: a wrong email, a wrong
 * password, and a missing user all return the same 401. The captcha is checked
 * before the password, so a bot cannot use the login endpoint as a password
 * oracle.
 */
import { Controller, Get, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { token } from '@tsir/container';
import type { RequestContext } from '@tsir/http';

import { registry } from '../registry.ts';
import { type AuthService, type AppPrincipal } from '../services/auth.service.ts';
import type { CaptchaService } from '../services/captcha.service.ts';
import { type PasswordResetService } from '../services/password-reset.service.ts';
import { type MailService } from '../../mail/index.ts';
import { type AuditService } from '../../shared/audit.ts';

export const LoginBody = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  // Optional: the captcha service enforces presence when CAPTCHA_DISABLED is
  // false. Making the field optional lets local/dev (captcha disabled) and the
  // frontend form (which omits it when disabled) skip it cleanly.
  captchaToken: z.string().max(4096).optional(),
});

export const ForgotBody = z.object({
  email: z.email(),
});

export const ResetBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

export const authControllerToken = token<AuthController>('AuthController');

@Controller(registry, '/api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly captcha: CaptchaService,
    private readonly passwordReset: PasswordResetService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  @Post('/login', { body: LoginBody, tags: ['auth'], operationId: 'auth.login' })
  async login({ body }: { body: z.infer<typeof LoginBody> }): Promise<Response> {
    // A missing captcha token fails verification the same way a wrong one does: the caller
    // either sends a token or gets a 400. `verifyCaptcha` requires a string, so the optional
    // field is normalised here rather than broadening the service's contract.
    const captcha = await this.captcha.verifyCaptcha(body.captchaToken ?? '');
    if (!captcha.ok) {
      return new Response(JSON.stringify({ error: 'captcha_failed', detail: captcha.error }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const cookie = await this.auth.login(body.email, body.password);
    if (cookie === null) {
      return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    const user = await this.auth.findUserByEmail(body.email);
    if (user) await this.audit.record({ actorId: user.id, action: 'auth.login' });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': cookie,
      },
    });
  }

  @Post('/logout', {
    guards: ['session'],
    principal: true,
    tags: ['auth'],
    operationId: 'auth.logout',
  })
  async logout({
    principal,
    ctx,
  }: {
    principal: AppPrincipal;
    ctx: RequestContext;
  }): Promise<Response> {
    const sessions = this.auth.getSessions();
    const token = sessions.tokenOf(ctx.request);
    if (token !== undefined) await this.auth.logout(token);
    await this.audit.record({ actorId: principal.data.userId, action: 'auth.logout' });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `${sessions.cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  @Post('/forgot-password', {
    body: ForgotBody,
    tags: ['auth'],
    operationId: 'auth.forgotPassword',
  })
  async forgotPassword({ body }: { body: z.infer<typeof ForgotBody> }): Promise<Response> {
    const issued = await this.passwordReset.issueResetToken(body.email);
    if (issued !== null) {
      await this.mail.sendResetPasswordEmail(issued.email, issued.token);
      await this.audit.record({
        actorId: issued.userId,
        action: 'auth.forgot_password',
        subject: body.email,
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  @Post('/reset-password', { body: ResetBody, tags: ['auth'], operationId: 'auth.resetPassword' })
  async resetPassword({ body }: { body: z.infer<typeof ResetBody> }): Promise<Response> {
    const valid = await this.passwordReset.isValidResetToken(body.token);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'invalid_or_expired_token' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const hash = await this.auth.hashPassword(body.password);
    const consumed = await this.passwordReset.consumeResetToken(body.token, hash);
    if (!consumed) {
      return new Response(JSON.stringify({ error: 'invalid_or_expired_token' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    await this.audit.record({ actorId: null, action: 'auth.reset_password' });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  @Get('/me', { guards: ['session'], principal: true, tags: ['auth'], operationId: 'auth.me' })
  async me({ principal }: { principal: AppPrincipal }): Promise<unknown> {
    const user = await this.auth.findUserById(principal.data.userId);
    return {
      id: user?.id,
      email: user?.email,
      displayName: user?.display_name,
      isSuperAdmin: user?.is_super_admin === 1,
    };
  }

  @Get('/captcha', { tags: ['auth'], operationId: 'auth.captchaConfig' })
  captchaConfig(): unknown {
    return { provider: this.captcha.provider, siteKey: this.captcha.siteKey };
  }
}
