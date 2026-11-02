/**
 * `configDir` — Laravel-style split project configuration, combined at load.
 *
 * Instead of putting every section (`database`, `cache`, `queue`, …) into one
 * `tsir.js`, keep one file per section under `config/`:
 *
 *   config/
 *     app.ts         → { name: 'shop', entry: './app.ts' }
 *     database.ts    → { default: 'primary', connections: { … } }
 *     cache.ts       → { default: 'app', stores: { … } }
 *
 * Then in `tsir.js`:
 *
 *   import { configDir } from '@tsir/config';
 *   export default await configDir(`${import.meta.dir}/config`);
 *
 * The filename (without extension) becomes the top-level key, matching
 * `PROJECT_TOP_LEVEL_KEYS`. Files are merged in directory order; later files
 * override earlier ones for the same key.
 *
 * The implementation lives in `adapters/config-dir.ts` because it needs
 * `node:fs`/`node:path`/`node:url`; this re-export keeps the barrel Web-safe.
 */

export { configDir } from './adapters/config-dir.ts';
