/**
 * Auth state for the SPA.
 *
 * On startup, `bootstrap()` checks install status, then either redirects to
 * `/setup` (fresh install) or `/login` (not authenticated). Authenticated
 * pages read `auth.user` and `auth.installed` reactively.
 *
 * State lives in a single exported `$state` object; the module mutates its
 * properties so changes propagate to every component.
 */
import { api } from './api.ts';

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  isSuperAdmin: boolean;
  emailVerified: boolean;
}

export const auth = $state({
  installed: null as boolean | null,
  user: null as User | null,
  bootstrapped: false as boolean,
  bootError: null as string | null,
});

/** Fetch `/api/auth/setup` to decide where the SPA should land. */
export async function bootstrap(): Promise<void> {
  try {
    const res = await api<{ installed: boolean }>('/api/auth/setup');
    auth.installed = res.installed;
    if (auth.installed) {
      try {
        const me = await api<User>('/api/auth/me');
        auth.user = me;
      } catch {
        auth.user = null;
      }
    }
  } catch (err) {
    auth.bootError = err instanceof Error ? err.message : String(err);
  } finally {
    auth.bootstrapped = true;
  }
}

export function clearUser(): void {
  auth.user = null;
}
