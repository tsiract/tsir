/**
 * The media module's public surface.
 *
 * A second app (or a test) can boot `media.routes()` without the users module
 * existing in the process — that is what "module" buys.
 */

export { media } from './routes.ts';
