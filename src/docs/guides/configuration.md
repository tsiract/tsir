# Configuration and secrets

## Two layers, one rule

Tsir splits configuration into two layers, and neither one magically creates runtime clients:

- **`tsir.js`** tells the CLI and deploy tools about your project — which modules exist, which
  database connections are declared, which cache stores are named. It is a declaration, not a
  connection.
- **`config.ts`** (via `defineConfig` / `loadConfig`) validates your environment variables and
  gives you typed access to them at runtime.

The rule: **declaring a resource in `tsir.js` does not instantiate it.** If you declare a D1
connection named `primary`, you still bind the actual D1 binding in `app.ts` and pass it to
`createDatabase`. This is the same separation Laravel uses: `config/database.php` declares
connections, but your service provider still hands the resolved PDO instance to your code.

```ts verify
import { defineConfig, env, loadConfig } from '@tsir/config';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  PORT: env.int({ min: 1, max: 65535, default: 3000 }),
  API_KEY: env.secret(),
});
const config = loadConfig(spec, { env: { API_KEY: 'example-not-a-real-secret' } });
console.log(config.values.PORT, config.masked.API_KEY); // 3000, [redacted]
```

Precedence is explicit overrides, then environment, then validated defaults. `env.secret()` returns
a redacted wrapper; reveal only at the client boundary and never log the result. Put development
values in ignored `.env` files; production secrets belong in the deployment platform's secret
store or bindings, not in `tsir.js`, generated artifacts or source control.

## Project file

A minimal valid `tsir.js` follows; `entry` is relative to the application directory. Other blocks
include named `database.connections`, `cache.stores`, `queue.connections`, `storage.disks`, and
`deploy.targets`. Declare a default name that exists and pass concrete clients/bindings to the
relevant runtime builders. The CLI validates known keys; keep secrets as `{ fromEnv: 'NAME' }`
where the specific config field supports it. Not every runtime driver's options are exposed by
the project schema: notably SQS `queueUrl` and FIFO options must be supplied to `createQueues`
programmatically in this version.

```js
export default {
  app: { name: 'my-app', entry: './app.ts' },
  cache: {
    default: 'profiles',
    stores: { profiles: { driver: 'database', connection: 'primary' } },
  },
  database: { default: 'primary', connections: { primary: { driver: 'd1', binding: 'DB' } } },
  deploy: { topology: 'separate', targets: { cloudflare: {}, lambda: {} } },
};
```

This example declares resources, but still requires the application to provide a D1 binding and a
compatible SQL cache adapter and to create the cache table. D1 cannot be bound directly in Lambda;
choose a supported database there. Run `tsir doctor` and `tsir config:dump` in the app directory;
review masked output and errors rather than printing secret values. See the
[config reference](../packages/config.md) and [provider guide](./providers.md).
