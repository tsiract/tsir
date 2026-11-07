// config/deploy.ts — deployment targets for the admin application.
//
// The admin app runs on its own subdomain (`admin.product.com`) in production.
// The Cloudflare target declares the domain so `tsir deploy:build` emits a
// `routes` entry in `wrangler.*.toml`, binding the Worker to that hostname.
// The Lambda target emits a `DomainName` parameter in `template.*.yaml` so the
// operator can wire an API Gateway custom domain or ALB host-based rule.
// The frontpage (static) is served from the apex domain via Cloudflare Pages.
//
// The D1 binding (`DB`) is declared on the `http` unit so the request-serving
// Worker can reach the database; the migrate unit gets it automatically from
// the database connection's `binding` field.
export default {
  targets: {
    cloudflare: {
      compatibilityDate: '2026-09-01',
      domain: 'admin.product.com',
      zone: 'product.com',
      vars: {
        APP_ENV: 'production',
      },
      bindings: {
        // D1 resource is "<database-id>:<database-name>" — the id comes from
        // `wrangler d1 list`; the name is what you created it with.
        DB: { kind: 'd1', resource: 'db-id:admin' },
      },
    },
    lambda: {
      runtime: 'nodejs20.x',
      memoryMb: 256,
      timeoutSeconds: 30,
      domain: 'admin.product.com',
      zone: 'product.com',
      vars: {
        APP_ENV: 'production',
      },
      bindings: {
        DB: { kind: 'd1', resource: 'db-id:admin' },
      },
    },
  },
  units: [
    {
      name: 'http',
      kind: 'http',
      bindings: [{ kind: 'd1', name: 'DB', resource: 'db-id:admin' }],
    },
  ],
};
