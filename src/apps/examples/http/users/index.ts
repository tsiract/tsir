/**
 * The users module's public surface.
 *
 * Everything another module may import is re-exported here — and only here.
 * `make check` fails if a module reaches past this file into
 * `http/users.controller.ts`.
 */

export { users } from './routes.ts';
