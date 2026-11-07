export { createAuthModule, captchaServiceToken } from './routes.ts';
export {
  authServiceToken,
  guardToken,
  hasherToken,
  sessionsToken,
  AuthService,
  createGuardFromSessions,
  createSessionsFromDb,
  createSuperAdminGuard,
} from './services/auth.service.ts';
export { socializeToken } from './services/socialize.ts';
export type { AppPrincipal, AuthPrincipal } from './services/auth.service.ts';
// Importing the controller registers its routes into the module registry.
import './http/auth.controller.ts';
