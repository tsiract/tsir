/**
 * Captcha verification.
 *
 * Cloudflare Turnstile by default — the site key goes in `config.json`, the
 * secret comes from the `CAPTCHA_SECRET` environment variable. A request with no
 * configured secret is refused (captcha is mandatory on login), but a test or
 * local run can set `CAPTCHA_DISABLED=true` to skip verification.
 *
 * Env values are injected via the config provider — no `process.env` here.
 */
import { readConfig } from '../../../database.ts';

const config = readConfig() as {
  captcha?: { provider?: string; siteKey?: string; secret?: { fromEnv?: string } | string };
};

const provider = config.captcha?.provider ?? 'turnstile';
const siteKey = config.captcha?.siteKey ?? '';

export interface CaptchaResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
}

/**
 * Build the captcha service. The `disabled` flag and `secret` come from the
 * loaded config (env), not `process.env`.
 */
export function createCaptchaService(options: {
  readonly disabled: boolean;
  readonly secret: string;
}): {
  readonly provider: string;
  readonly siteKey: string;
  readonly verifyCaptcha: (token: string) => Promise<CaptchaResult>;
} {
  const { disabled, secret } = options;

  async function verifyCaptcha(token: string): Promise<CaptchaResult> {
    if (disabled) return { ok: true };
    if (token === undefined || token === '') return { ok: false, error: 'missing' };

    if (secret === undefined || secret === '') {
      return { ok: false, error: 'not_configured' };
    }

    if (provider === 'turnstile') {
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, response: token }),
      });
      const body = (await response.json()) as { success: boolean; 'error-codes'?: string[] };
      if (body.success) return { ok: true };
      return { ok: false, error: (body['error-codes'] ?? ['verify_failed']).join(',') };
    }

    return { ok: false, error: `unknown_provider:${provider}` };
  }

  return { provider, siteKey, verifyCaptcha };
}

export type CaptchaService = ReturnType<typeof createCaptchaService>;
