/**
 * Host port sweep (`make kill`).
 *
 * `kill-dev.sh` is deliberately surgical: it signals only PIDs it recorded, whose
 * start label still matches. That is the right behaviour for `make dev`'s
 * automatic cleanup, but it leaves the machine in a state where a stray
 * `bun --hot` from an earlier session still owns :3000 and the next boot fails
 * with EADDRINUSE.
 *
 * `make kill` therefore sweeps every listening TCP port on the host — with a
 * protection policy, because "kill everything" is a foot-gun:
 *
 *   1. Docker's own ports and processes are never touched. Losing the daemon
 *      because you wanted port 3000 back is not an acceptable failure mode.
 *      This covers dockerd/containerd/docker-proxy/docker desktop/colima/podman,
 *      the daemon API (2375/2376), swarm (2377/7946) and overlay (4789).
 *   2. System services (sshd, DNS, mDNS, CUPS) are never touched.
 *   3. Processes owned by another user, PID 1, this process and its parent are
 *      never touched — a dev tool that can kill root's processes is a dev tool
 *      that can kill the machine.
 *   4. Data services (postgres, mysql, redis, mongo, elasticsearch) are protected
 *      by default and freed only with `--include-infra`, because dropping a
 *      developer's database is not "cleaning up".
 *
 * Everything else — dev servers, watchers, bundlers, stray node/bun processes —
 * gets SIGTERM, then SIGKILL after `--grace` ms, and the port is re-checked.
 *
 *   bun src/tools/kill-ports.ts --dry-run      # show the table, touch nothing
 *   bun src/tools/kill-ports.ts                # sweep
 *   bun src/tools/kill-ports.ts --include-infra
 */

export interface Listener {
  readonly port: number;
  readonly address: string;
  readonly pid: number | undefined;
  readonly command: string;
}

export type Decision =
  | { readonly action: 'kill'; readonly reason: string }
  | { readonly action: 'keep'; readonly reason: string };

/** Ports that belong to the container runtime, not to the application. */
export const DOCKER_PORTS: readonly number[] = [2375, 2376, 2377, 7946, 4789];

/** Ports owned by the operating system's own services. */
export const SYSTEM_PORTS: readonly number[] = [22, 53, 123, 631, 5353];

/** Data services: killing these loses work, so they are opt-in. */
export const INFRA_PORTS: readonly number[] = [
  3306, // mysql / mariadb
  5432, // postgres
  6379, // redis / valkey
  9200, // elasticsearch / opensearch http
  9300, // elasticsearch / opensearch transport
  27017, // mongodb
  5672, // rabbitmq
];

/** Process names that must survive a port sweep. */
export const PROTECTED_PROCESS =
  /docker|containerd|containerd-shim|docker-proxy|colima|vpnkit|qemu|vmnet|podman|orbstack|com\.apple\.Virtualization|com\.docker/i;

/**
 * Parses `ss -lntp`.
 *
 *   LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("bun",pid=4242,fd=18))
 *
 * The process column is optional: without `-p` (or as a non-owner) it is absent,
 * which is why `pid` is `number | undefined` rather than a sentinel.
 */
export function parseSs(stdout: string): readonly Listener[] {
  const listeners: Listener[] = [];

  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || columns[0] !== 'LISTEN') continue;

    const local = columns[3] ?? '';
    const colon = local.lastIndexOf(':');
    if (colon === -1) continue;
    const port = Number.parseInt(local.slice(colon + 1), 10);
    if (!Number.isFinite(port)) continue;

    const process = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    listeners.push({
      port,
      address: local.slice(0, colon),
      pid: process?.[2] === undefined ? undefined : Number.parseInt(process[2], 10),
      command: process?.[1] ?? '',
    });
  }

  return listeners;
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN` (macOS, where `ss` does not exist).
 *
 *   bun 4242 user 21u IPv6 0x1234 0t0 TCP *:3000 (LISTEN)
 */
export function parseLsof(stdout: string): readonly Listener[] {
  const listeners: Listener[] = [];

  for (const line of stdout.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9) continue;
    const name = columns[8] ?? '';
    const colon = name.lastIndexOf(':');
    if (colon === -1) continue;
    const port = Number.parseInt(name.slice(colon + 1), 10);
    if (!Number.isFinite(port)) continue;

    listeners.push({
      port,
      address: name.slice(0, colon),
      pid: Number.parseInt(columns[1] ?? '', 10),
      command: columns[0] ?? '',
    });
  }

  return listeners;
}

export interface PolicyContext {
  readonly selfPid: number;
  readonly parentPid: number;
  readonly isRoot: boolean;
  readonly includeInfra: boolean;
  readonly ownerPids: ReadonlySet<number> | undefined;
}

/** Decides what happens to one listener. Pure: no signals, no IO. */
export function decide(listener: Listener, context: PolicyContext): Decision {
  const { port, pid, command } = listener;

  if (pid === undefined) {
    return { action: 'keep', reason: 'no process visible (another user owns it)' };
  }
  if (pid === context.selfPid) return { action: 'keep', reason: 'this process' };
  if (pid === context.parentPid) return { action: 'keep', reason: 'parent process' };
  if (pid === 1) return { action: 'keep', reason: 'init' };

  if (PROTECTED_PROCESS.test(command)) {
    return { action: 'keep', reason: `container runtime (${command})` };
  }
  if (DOCKER_PORTS.includes(port)) {
    return { action: 'keep', reason: 'container runtime port' };
  }
  if (SYSTEM_PORTS.includes(port)) {
    return { action: 'keep', reason: 'system service port' };
  }
  if (INFRA_PORTS.includes(port) && !context.includeInfra) {
    return { action: 'keep', reason: 'data service (pass --include-infra to free)' };
  }
  if (context.ownerPids !== undefined && !context.ownerPids.has(pid)) {
    return { action: 'keep', reason: 'another user owns this process' };
  }
  if (context.isRoot && context.ownerPids === undefined) {
    return { action: 'keep', reason: 'running as root: refusing to guess ownership' };
  }

  return { action: 'kill', reason: command === '' ? 'listener' : command };
}

function listListeners(): readonly Listener[] {
  if (process.platform === 'darwin') {
    const run = Bun.spawnSync(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN']);
    return parseLsof(run.stdout.toString());
  }
  const run = Bun.spawnSync(['ss', '-lntp']);
  return parseSs(run.stdout.toString());
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const includeInfra = args.includes('--include-infra');
  const graceIndex = args.indexOf('--grace');
  const graceMs = graceIndex === -1 ? 3000 : Number(args[graceIndex + 1] ?? 3000);

  const ownerPids = new Set<number>();
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    const ps = Bun.spawnSync(['ps', '-o', 'pid=,uid=', '-ax']);
    for (const line of ps.stdout.toString().split('\n')) {
      const [pid, lineUid] = line.trim().split(/\s+/);
      if (pid !== undefined && Number(lineUid) === uid) ownerPids.add(Number(pid));
    }
  }

  const context: PolicyContext = {
    selfPid: process.pid,
    parentPid: process.ppid,
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
    includeInfra,
    ownerPids: typeof process.getuid === 'function' ? ownerPids : undefined,
  };

  // One row per port. A port can appear several times (0.0.0.0 and a specific
  // interface, IPv4 and IPv6); prefer the entry that names a process, otherwise
  // the pid-less duplicate would mask the real owner.
  const byPort = new Map<number, Listener>();
  for (const listener of listListeners()) {
    const existing = byPort.get(listener.port);
    if (existing === undefined || (existing.pid === undefined && listener.pid !== undefined)) {
      byPort.set(listener.port, listener);
    }
  }

  const rows: string[] = [];
  const targets: Listener[] = [];

  for (const listener of [...byPort.values()].sort((a, b) => a.port - b.port)) {
    const decision = decide(listener, context);
    const mark = decision.action === 'kill' ? '✗' : '·';
    const label = listener.command === '' ? `pid ${String(listener.pid ?? '?')}` : listener.command;
    rows.push(
      `  ${mark} ${String(listener.port).padStart(5)}  ${label.padEnd(20)} ${
        decision.action === 'kill' ? 'killing' : 'keep'
      } — ${decision.reason}`,
    );
    if (decision.action === 'kill') targets.push(listener);
  }

  process.stdout.write(
    '\n port sweep · everything listening, except runtimes and system services\n\n',
  );
  process.stdout.write(`${rows.join('\n')}\n\n`);

  if (targets.length === 0) {
    process.stdout.write('  ✓ nothing to free\n\n');
    process.exit(0);
  }

  if (dryRun) {
    process.stdout.write(`  · --dry-run: would free ${String(targets.length)} port(s)\n\n`);
    process.exit(0);
  }

  for (const target of targets) {
    if (target.pid === undefined) continue;
    try {
      process.kill(target.pid, 'SIGTERM');
    } catch {
      // Already gone between listing and signalling; the port check below is the
      // source of truth, not the signal call.
    }
  }

  const deadline = Date.now() + graceMs;
  const stillOpen = (): readonly Listener[] => {
    const open = new Set(listListeners().map((listener) => listener.port));
    return targets.filter((target) => open.has(target.port));
  };

  let remaining = stillOpen();
  while (remaining.length > 0 && Date.now() < deadline) {
    Bun.sleepSync(100);
    remaining = stillOpen();
  }

  for (const target of remaining) {
    if (target.pid === undefined) continue;
    process.stderr.write(`  · ${String(target.port)} ignored SIGTERM — sending SIGKILL\n`);
    try {
      process.kill(target.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  Bun.sleepSync(100);
  const survivors = stillOpen();

  if (survivors.length > 0) {
    process.stderr.write(
      `\n  ✗ ${String(survivors.length)} port(s) still listening: ${survivors
        .map((listener) => String(listener.port))
        .join(', ')}\n\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`  ✓ freed ${String(targets.length)} port(s)\n\n`);
}
