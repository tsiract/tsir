export { createMailModule, appUrlToken } from './routes.ts';
export {
  MailService,
  mailServiceToken,
  mailers,
  mailersToken,
  mailersProvider,
} from './services/mail.service.ts';
// Importing the controller registers its routes into the module registry.
import './http/mail.controller.ts';
