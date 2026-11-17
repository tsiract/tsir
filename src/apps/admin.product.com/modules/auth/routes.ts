import { routeModule as _routeModule } from '@tsir/router';
import { registry } from './registry.ts';
import { classProvider, factoryProvider, token, valueProvider } from '@tsir/container';
import { defaultHasher } from '@tsir/auth';
import type { LoadedConfig } from '@tsir/config';

import { dbToken, drizzleToken } from '../../database.ts';
import {
  AuthService,
  authServiceToken,
  createGuardFromSessions,
  createSessionsFromDb,
  guardToken,
  hasherToken,
  sessionsToken,
} from './services/auth.service.ts';
import {
  PasswordResetService,
  passwordResetServiceToken,
} from './services/password-reset.service.ts';
import { createCaptchaService, type CaptchaService } from './services/captcha.service.ts';
import { AuthController, authControllerToken } from './http/auth.controller.ts';
import { createSocializeProviders } from './services/socialize.ts';
import { mailServiceToken } from '../mail/index.ts';
import { auditServiceToken } from '../shared/audit.ts';

/** Token for the captcha service. */
export const captchaServiceToken = token<CaptchaService>('captchaService');

/** Captcha + socialize config fields the auth module reads from the loaded app config. */
type AuthConfig = {
  CAPTCHA_DISABLED: boolean;
  CAPTCHA_SECRET: string;
  SOCIALIZE_STATE_SECRET: string;
  SOCIALIZE_GOOGLE_CLIENT_ID: string;
  SOCIALIZE_GOOGLE_CLIENT_SECRET: string;
  SOCIALIZE_GOOGLE_REDIRECT_URI: string;
  SOCIALIZE_GITHUB_CLIENT_ID: string;
  SOCIALIZE_GITHUB_CLIENT_SECRET: string;
  SOCIALIZE_GITHUB_REDIRECT_URI: string;
};

/**
 * Build the auth module. Config is needed for the captcha env flags
 * (`CAPTCHA_DISABLED`, `CAPTCHA_SECRET`).
 */
export function createAuthModule(
  config: LoadedConfig<AuthConfig>,
): ReturnType<typeof _routeModule> {
  const v = config.values;

  // Build the socialize layer from config. Providers with empty client ids are
  // skipped so the app boots without OAuth credentials configured.
  const { socializeProvider } = createSocializeProviders({
    stateSecret: v.SOCIALIZE_STATE_SECRET,
    ...(v.SOCIALIZE_GOOGLE_CLIENT_ID !== '' && v.SOCIALIZE_GOOGLE_CLIENT_SECRET !== ''
      ? {
          google: {
            clientId: v.SOCIALIZE_GOOGLE_CLIENT_ID,
            clientSecret: v.SOCIALIZE_GOOGLE_CLIENT_SECRET,
            redirectUri: v.SOCIALIZE_GOOGLE_REDIRECT_URI,
          },
        }
      : {}),
    ...(v.SOCIALIZE_GITHUB_CLIENT_ID !== '' && v.SOCIALIZE_GITHUB_CLIENT_SECRET !== ''
      ? {
          github: {
            clientId: v.SOCIALIZE_GITHUB_CLIENT_ID,
            clientSecret: v.SOCIALIZE_GITHUB_CLIENT_SECRET,
            redirectUri: v.SOCIALIZE_GITHUB_REDIRECT_URI,
          },
        }
      : {}),
  });

  const providers = [
    // Hasher is stateless — a value provider is fine.
    valueProvider(hasherToken, defaultHasher()),
    // Sessions depend on the (deferred) db.
    factoryProvider(sessionsToken, (db) => createSessionsFromDb(db), [dbToken]),
    // Guard depends on sessions.
    factoryProvider(guardToken, (sessions) => createGuardFromSessions(sessions), [sessionsToken]),
    // Captcha service closes over env config.
    factoryProvider(
      captchaServiceToken,
      () =>
        createCaptchaService({
          disabled: config.values.CAPTCHA_DISABLED,
          secret: config.values.CAPTCHA_SECRET,
        }),
      [],
    ),
    // Social auth (Socialize) — optional providers are skipped above.
    socializeProvider,
    // Password reset service.
    classProvider(passwordResetServiceToken, PasswordResetService, [dbToken, drizzleToken]),
    // Auth service.
    classProvider(authServiceToken, AuthService, [dbToken, hasherToken, sessionsToken, guardToken]),
    // Controller (scoped — one instance per request).
    classProvider(
      authControllerToken,
      AuthController,
      [
        authServiceToken,
        captchaServiceToken,
        passwordResetServiceToken,
        mailServiceToken,
        auditServiceToken,
      ],
      { lifetime: 'scoped' },
    ),
  ];

  return _routeModule({
    name: 'auth',
    registry,
    unit: 'http',
    providers,
  });
}
