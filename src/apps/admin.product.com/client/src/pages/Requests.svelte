<script lang="ts">
  import { api } from '../lib/api.ts';
  import { router, setQuery } from '../lib/router.svelte.ts';
  import DataTable from '../components/DataTable.svelte';

  interface RequestLog {
    id: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    principalSubject: string | null;
    ip: string | null;
    userAgent: string | null;
    createdAt: string | number;
  }

  let data = $state<{ data: RequestLog[] } | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const methodFilter = $derived(router.query.get('method') ?? '');
  const statusFilter = $derived(router.query.get('status') ?? '');

  function statusClass(status: number): string {
    if (status >= 500) return 'badge badge-error';
    if (status >= 400) return 'badge badge-warning';
    if (status >= 300) return 'badge badge-info';
    return 'badge badge-success';
  }

  function methodClass(method: string): string {
    switch (method) {
      case 'GET': return 'badge badge-success';
      case 'POST': return 'badge badge-info';
      case 'PUT': case 'PATCH': return 'badge badge-warning';
      case 'DELETE': return 'badge badge-error';
      default: return 'badge badge-ghost';
    }
  }

  const columns = [
    { key: 'createdAt', label: 'Time', className: 'whitespace-nowrap text-xs', render: (v: unknown) => new Date(v as string | number).toLocaleString() },
    { key: 'method', label: 'Method', render: (v: unknown) => `<span class="${methodClass(String(v))}">${String(v)}</span>` },
    { key: 'path', label: 'Path', className: 'font-mono text-xs' },
    { key: 'status', label: 'Status', render: (v: unknown) => `<span class="${statusClass(Number(v))}">${String(v)}</span>` },
    { key: 'durationMs', label: 'Duration', className: 'text-right text-xs', render: (v: unknown) => `${String(v)}ms` },
    { key: 'principalSubject', label: 'Principal', className: 'text-xs text-base-content/70', render: (v: unknown) => String(v ?? 'anonymous') },
  ];

  $effect(() => {
    void router.query;
    void load();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams();
      if (methodFilter) params.set('method', methodFilter);
      if (statusFilter) params.set('status', statusFilter);
      params.set('limit', '100');
      const res = await api<{ data: RequestLog[] }>(`/api/requests?${params.toString()}`);
      data = res;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load request logs';
      data = null;
    } finally {
      loading = false;
    }
  }

  function onMethodChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    setQuery((q) => {
      if (value) q.set('method', value);
      else q.delete('method');
    });
  }

  function onStatusChange(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    setQuery((q) => {
      if (value) q.set('status', value);
      else q.delete('status');
    });
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <div>
      <h1 class="text-2xl font-bold">Request Logs</h1>
      <p class="text-base-content/70 mt-1 text-sm">Telescope-style audit of HTTP requests handled by the admin app.</p>
    </div>
    <button class="btn btn-sm btn-outline" onclick={load}>Refresh</button>
  </div>

  <div class="flex gap-3 flex-wrap">
    <select class="select select-bordered select-sm" value={methodFilter} onchange={onMethodChange}>
      <option value="">All methods</option>
      <option value="GET">GET</option>
      <option value="POST">POST</option>
      <option value="PUT">PUT</option>
      <option value="PATCH">PATCH</option>
      <option value="DELETE">DELETE</option>
    </select>
    <input
      class="input input-bordered input-sm w-32"
      type="number"
      placeholder="Status"
      value={statusFilter}
      oninput={onStatusChange}
    />
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {:else}
    <DataTable
      columns={columns}
      rows={data?.data ?? []}
      loading={loading}
      total={data?.data.length ?? 0}
      perPage={data?.data.length ?? 1}
      page={1}
    />
  {/if}
</div>
