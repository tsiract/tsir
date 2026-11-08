/** Public ecosystem inventory. Status is release readiness, not whether a directory exists. */
export type PackageStatus = 'implemented' | 'partial';
export type PackageGroup =
  'foundation' | 'http' | 'data' | 'capabilities' | 'connect' | 'operations';

export interface PackageCard {
  readonly name: string;
  readonly title: string;
  readonly group: PackageGroup;
  readonly phase: number;
  readonly status: PackageStatus;
  readonly description: string;
  readonly caveat?: string;
  readonly icon: string;
}

export const groups: readonly { id: PackageGroup | 'all'; label: string }[] = [
  { id: 'all', label: 'All packages' },
  { id: 'foundation', label: 'Foundation' },
  { id: 'http', label: 'HTTP & CLI' },
  { id: 'data', label: 'Data & secrets' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'connect', label: 'Connect & deploy' },
  { id: 'operations', label: 'Operations' },
];

export const packages: readonly PackageCard[] = [
  {
    name: 'core',
    title: 'Application core',
    group: 'foundation',
    phase: 1,
    status: 'implemented',
    icon: 'box',
    description:
      'A small application lifecycle, explicit modules, a typed manifest and ordered shutdown.',
  },
  {
    name: 'container',
    title: 'Dependency injection',
    group: 'foundation',
    phase: 1,
    status: 'implemented',
    icon: 'nodes',
    description:
      'Branded tokens, scoped lifetimes and constructor injection. No global service locator.',
  },
  {
    name: 'config',
    title: 'Typed configuration',
    group: 'foundation',
    phase: 1,
    status: 'implemented',
    icon: 'sliders',
    description:
      'Validate your environment, redact secrets and report every configuration issue at boot.',
  },
  {
    name: 'validate',
    title: 'Schema validation',
    group: 'foundation',
    phase: 2,
    status: 'partial',
    icon: 'check',
    description:
      'Standard Schema adapters, Zod 4, typed HTTP helpers and file constraints at trust boundaries.',
    caveat: 'The validation surface is built; pre-alpha release verification is still in progress.',
  },
  {
    name: 'testing',
    title: 'Application testing',
    group: 'foundation',
    phase: 1,
    status: 'implemented',
    icon: 'flask',
    description:
      'Boot the real application in tests with DI overrides, in-process HTTP and a fixed clock.',
  },
  {
    name: 'tui',
    title: 'Terminal interface',
    group: 'foundation',
    phase: 1,
    status: 'implemented',
    icon: 'terminal',
    description:
      'One prompt/wizard layer for the CLI, the distribution tooling and the framework commands: shared keys, terminal restoration on every exit, and a reporting path that works in a pipe.',
  },
  {
    name: 'router',
    title: 'Typed routing',
    group: 'http',
    phase: 2,
    status: 'partial',
    icon: 'route',
    description:
      'Standard decorators, a trie matcher and deterministic route codegen into routes.gen.ts.',
    caveat:
      'Routing and codegen are available; the HTTP release gate still has open integration work.',
  },
  {
    name: 'http',
    title: 'Request pipeline',
    group: 'http',
    phase: 2,
    status: 'partial',
    icon: 'globe',
    description:
      'Web-standard handlers, middleware, guards, response contracts, uploads and OpenAPI 3.1.',
    caveat: 'Streaming request bodies and the dev OpenAPI endpoint are still open.',
  },
  {
    name: 'console',
    title: 'The tsir CLI',
    group: 'http',
    phase: 1,
    status: 'implemented',
    icon: 'terminal',
    description:
      'Project generators, doctor, route compilation, migrations, seeds, keys and deploy plans.',
  },
  {
    name: 'database',
    title: 'Database & Drizzle',
    group: 'data',
    phase: 3,
    status: 'partial',
    icon: 'database',
    description:
      'D1 and Postgres drivers, explicit transactions, atomic batches and encrypted column codecs.',
    caveat:
      'MySQL integration and bootstrap tasks remain open. D1 does not fake interactive transactions.',
  },
  {
    name: 'migrate',
    title: 'Migrations',
    group: 'data',
    phase: 3,
    status: 'implemented',
    icon: 'layers',
    description:
      'Drizzle’s authoritative journal, connection-pinned locks, drift checks and explicit rollback.',
  },
  {
    name: 'seed',
    title: 'Deterministic seeds',
    group: 'data',
    phase: 3,
    status: 'implemented',
    icon: 'seed',
    description:
      'Repeatable seed data with an injected clock and RNG, ordering checks and idempotency tests.',
  },
  {
    name: 'vault',
    title: 'Column encryption',
    group: 'data',
    phase: 4,
    status: 'partial',
    icon: 'lock',
    description:
      'Versioned AES-256-GCM envelopes, column-bound authentication and resumable key rotation.',
    caveat: 'Rotation telemetry export and spans still need their telemetry consumer.',
  },
  {
    name: 'auth',
    title: 'Authentication',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'shield',
    description:
      'Sessions, password hashing, API keys and composable guards behind explicit stores.',
  },
  {
    name: 'policy',
    title: 'Authorization',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'key',
    description:
      'Typed permissions, role graphs and policy decisions that connect to the HTTP pipeline.',
  },
  {
    name: 'cache',
    title: 'Cache',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'bolt',
    description:
      'Named stores with memory, database and Cloudflare KV drivers and declared capabilities.',
  },
  {
    name: 'queue',
    title: 'Background jobs',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'queue',
    description: 'Typed jobs, retry policies, workers and database or Cloudflare Queues drivers.',
  },
  {
    name: 'events',
    title: 'Events & outbox',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'broadcast',
    description: 'Typed events and listeners with explicit delivery modes and a durable outbox.',
  },
  {
    name: 'schedule',
    title: 'Scheduled tasks',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'clock',
    description: 'UTC cron parsing, task registries, next-run calculation and shared locks.',
  },
  {
    name: 'mail',
    title: 'Mail',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'mail',
    description:
      'Typed messages and templates with transport capabilities and app-supplied provider clients.',
  },
  {
    name: 'notify',
    title: 'Notifications',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'bell',
    description: 'One notification contract across inbox, mail, chat, SMS and signed webhooks.',
  },
  {
    name: 'storage',
    title: 'File storage',
    group: 'capabilities',
    phase: 7,
    status: 'implemented',
    icon: 'folder',
    description:
      'Explicit storage disks, bounded file operations and drivers for local and object storage.',
  },
  {
    name: 'link',
    title: 'Service connections',
    group: 'connect',
    phase: 5,
    status: 'partial',
    icon: 'link',
    description:
      'REST, gRPC, SOAP and WebSocket clients sharing deadlines, cancellation and retry budgets.',
    caveat: 'The room model is built; its Workers deployment binding is still open in deploy.',
  },
  {
    name: 'deploy',
    title: 'Deploy units',
    group: 'connect',
    phase: 6,
    status: 'partial',
    icon: 'cloud',
    description:
      'A committed unit graph and per-unit artifacts for Cloudflare Workers and AWS Lambda.',
    caveat:
      'Artifacts build locally. Real Workers and Lambda deployment verification is still open.',
  },
  {
    name: 'pulse',
    title: 'Observability',
    group: 'operations',
    phase: 7,
    status: 'implemented',
    icon: 'pulse',
    description:
      'Redacted structured logs, bounded metrics, sampled spans and honest readiness signals.',
  },
  {
    name: 'socialize',
    title: 'Social authentication',
    group: 'capabilities',
    phase: 8,
    status: 'implemented',
    icon: 'link',
    description: 'OAuth providers (Google, GitHub) with signed CSRF state.',
  },
  {
    name: 'media',
    title: 'Image & video',
    group: 'capabilities',
    phase: 8,
    status: 'partial',
    icon: 'layers',
    description:
      'Upload, transform and deliver via Cloudinary, Cloudflare, ImageKit, sharp, ffmpeg.',
    caveat: 'Adapters tested against stubs; real vendor integration tests pending.',
  },
  {
    name: 'cashier',
    title: 'Payments',
    group: 'capabilities',
    phase: 8,
    status: 'partial',
    icon: 'key',
    description: 'Stripe API client and webhook signature verification.',
    caveat: 'Stripe client and webhook verification tested; more providers not wired.',
  },
  {
    name: 'broadcast',
    title: 'Realtime channels',
    group: 'capabilities',
    phase: 8,
    status: 'partial',
    icon: 'broadcast',
    description: 'In-process pub/sub, WebSockets and presence channels.',
    caveat: 'Memory broadcaster and WebSocket handler ship; Redis backend still open.',
  },
  {
    name: 'pennant',
    title: 'Feature flags',
    group: 'capabilities',
    phase: 8,
    status: 'partial',
    icon: 'sliders',
    description: 'Boolean and percentage rollouts with memory, database and null stores.',
    caveat: 'Stores and evaluation implemented; a remote flag sync driver is not available.',
  },
  {
    name: 'scout',
    title: 'Full-text search',
    group: 'capabilities',
    phase: 8,
    status: 'partial',
    icon: 'search',
    description: 'Index and search via memory, SQLite and Postgres engines.',
    caveat: 'Memory and SQLite drivers tested; Postgres full-text needs coverage.',
  },
  {
    name: 'nightwatch',
    title: 'End-to-end testing',
    group: 'operations',
    phase: 8,
    status: 'partial',
    icon: 'flask',
    description: 'Browser-backend port with in-memory and Playwright backends.',
    caveat: 'In-memory backend runs; Playwright needs a browser binary in CI.',
  },
  {
    name: 'telemetry',
    title: 'Request & queue telemetry',
    group: 'operations',
    phase: 8,
    status: 'partial',
    icon: 'pulse',
    description: 'Request logging and queue-state monitoring in Drizzle tables.',
    caveat: 'Loggers and monitors implemented; aggregation dashboards not shipped.',
  },
  {
    name: 'forge',
    title: 'Server management',
    group: 'connect',
    phase: 8,
    status: 'partial',
    icon: 'cloud',
    description: 'Provision servers, run commands and execute deploy steps.',
    caveat: 'SSH runner and step model in place; cloud provisioning not wired.',
  },
];

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

export function renderPackages(): string {
  return packages
    .map((pkg) => {
      const source = `src/framework/${pkg.name}`;
      // `data-search` holds name + title + group; the description is visible text
      // and is searched via `textContent` in the client filter.
      const searchable = escape(`@tsir/${pkg.name} ${pkg.title} ${pkg.group}`.toLowerCase());
      return `<article class="package-card card" data-status="${pkg.status}" data-phase="${pkg.phase}" data-src="${source}" data-group="${pkg.group}" data-search="${searchable}">
      <div class="package-top"><span class="package-icon icon-${pkg.group}"><svg width="22" height="22" aria-hidden="true"><use href="#i-${pkg.icon}"/></svg></span><span class="badge status-badge status-${pkg.status}">${pkg.status === 'implemented' ? 'Implemented' : 'Partial'}</span></div>
      <h3><span class="pkg">@tsir/${pkg.name}</span></h3><p class="package-title">${escape(pkg.title)}</p><p class="package-description">${escape(pkg.description)}</p>
      ${pkg.caveat === undefined ? '' : `<p class="package-caveat">${escape(pkg.caveat)}</p>`}
      <div class="package-footer"><a href="docs/packages/${pkg.name}.html" aria-label="Read @tsir/${pkg.name} documentation">Read the docs <span aria-hidden="true">↗</span></a><span class="package-phase">P${pkg.phase}</span></div>
    </article>`;
    })
    .join('\n');
}
