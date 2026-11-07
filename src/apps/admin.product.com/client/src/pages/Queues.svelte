<script lang="ts">
  import { api } from '../lib/api.ts';
  import { router, setQuery } from '../lib/router.svelte.ts';
  import DataTable from '../components/DataTable.svelte';

  type JobState = 'pending' | 'running' | 'delayed' | 'failed';

  interface JobCounts {
    pending: number;
    running: number;
    delayed: number;
    failed: number;
  }

  interface JobRow {
    id: string;
    name: string;
    payload: string;
    connection: string;
    attempts: number;
    maxAttempts: number;
    availableAt: number;
    leasedUntil: number;
    createdAt: number;
    lastError: string | null;
    state: JobState;
  }

  let counts = $state<JobCounts | null>(null);
  let jobs = $state<{ data: JobRow[] } | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let selectedJob = $state<JobRow | null>(null);

  const stateFilter = $derived((router.query.get('state') ?? '') as JobState | '');

  function stateClass(state: JobState): string {
    switch (state) {
      case 'running': return 'badge badge-info';
      case 'pending': return 'badge badge-success';
      case 'delayed': return 'badge badge-warning';
      case 'failed': return 'badge badge-error';
    }
  }

  const columns = [
    { key: 'name', label: 'Name', className: 'font-mono text-xs' },
    { key: 'state', label: 'State', render: (v: unknown) => `<span class="${stateClass(v as JobState)}">${String(v)}</span>` },
    { key: 'attempts', label: 'Attempts', className: 'text-xs', render: (_v: unknown, row: Record<string, unknown>) => `${String(row.attempts)}/${String(row.maxAttempts)}` },
    { key: 'createdAt', label: 'Created', className: 'whitespace-nowrap text-xs', render: (v: unknown) => new Date(Number(v)).toLocaleString() },
    { key: 'lastError', label: 'Error', className: 'text-xs text-error max-w-xs truncate', render: (v: unknown) => String(v ?? '') },
  ];

  $effect(() => {
    void router.query;
    void load();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const countsRes = await api<JobCounts>('/api/queues/counts');
      counts = countsRes;

      const params = new URLSearchParams();
      if (stateFilter) params.set('state', stateFilter);
      params.set('limit', '100');
      const jobsRes = await api<{ data: JobRow[] }>(`/api/queues/jobs?${params.toString()}`);
      jobs = jobsRes;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load queue';
      jobs = null;
    } finally {
      loading = false;
    }
  }

  async function retryJob(id: string) {
    try {
      await api(`/api/queues/jobs/${id}/retry`, { method: 'POST' });
      selectedJob = null;
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to retry job';
    }
  }

  function onStateChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    setQuery((q) => {
      if (value) q.set('state', value);
      else q.delete('state');
    });
  }

  function tryParsePayload(payload: string): string {
    try {
      const obj = JSON.parse(payload);
      return JSON.stringify(obj, null, 2);
    } catch {
      return payload;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <div>
      <h1 class="text-2xl font-bold">Queue Monitor</h1>
      <p class="text-base-content/70 mt-1 text-sm">Horizon-style view of jobs across <code>queue_jobs</code> and <code>queue_dead</code>.</p>
    </div>
    <button class="btn btn-sm btn-outline" onclick={load}>Refresh</button>
  </div>

  <!-- State count cards -->
  {#if counts}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="card bg-base-200"><div class="card-body items-center text-center"><h3 class="card-title text-2xl text-success">{counts.pending}</h3><p class="text-sm text-base-content/60">Pending</p></div></div>
      <div class="card bg-base-200"><div class="card-body items-center text-center"><h3 class="card-title text-2xl text-info">{counts.running}</h3><p class="text-sm text-base-content/60">Running</p></div></div>
      <div class="card bg-base-200"><div class="card-body items-center text-center"><h3 class="card-title text-2xl text-warning">{counts.delayed}</h3><p class="text-sm text-base-content/60">Delayed</p></div></div>
      <div class="card bg-base-200"><div class="card-body items-center text-center"><h3 class="card-title text-2xl text-error">{counts.failed}</h3><p class="text-sm text-base-content/60">Failed</p></div></div>
    </div>
  {/if}

  <div class="flex gap-3 flex-wrap">
    <select class="select select-bordered select-sm" value={stateFilter} onchange={onStateChange}>
      <option value="">All states</option>
      <option value="pending">Pending</option>
      <option value="running">Running</option>
      <option value="delayed">Delayed</option>
      <option value="failed">Failed</option>
    </select>
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {:else}
    <DataTable
      columns={columns}
      rows={jobs?.data ?? []}
      loading={loading}
      total={jobs?.data.length ?? 0}
      perPage={jobs?.data.length ?? 1}
      page={1}
      onRowClick={(row) => { selectedJob = row as JobRow; }}
    >
      {#snippet actions(row)}
        {@const job = row as JobRow}
        {#if job.state === 'failed'}
          <button class="btn btn-xs btn-outline" onclick={(e) => { e.stopPropagation(); void retryJob(job.id); }}>Retry</button>
        {/if}
      {/snippet}
    </DataTable>
  {/if}

  <!-- Job detail drawer -->
  {#if selectedJob}
    <div class="fixed inset-0 bg-black/50 z-50" onclick={() => { selectedJob = null; }}>
      <div class="fixed right-0 top-0 h-full w-full max-w-lg bg-base-100 shadow-xl overflow-y-auto" onclick={(e) => e.stopPropagation()}>
        <div class="p-6 space-y-4">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-bold">Job details</h2>
            <button class="btn btn-ghost btn-sm" onclick={() => { selectedJob = null; }}>✕</button>
          </div>
          <div class="space-y-2 text-sm">
            <div><span class="text-base-content/60">ID:</span> <code>{selectedJob.id}</code></div>
            <div><span class="text-base-content/60">Name:</span> <code>{selectedJob.name}</code></div>
            <div><span class="text-base-content/60">Connection:</span> <code>{selectedJob.connection}</code></div>
            <div><span class="text-base-content/60">State:</span> <span class={stateClass(selectedJob.state)}>{selectedJob.state}</span></div>
            <div><span class="text-base-content/60">Attempts:</span> {selectedJob.attempts}/{selectedJob.maxAttempts}</div>
            <div><span class="text-base-content/60">Created:</span> {new Date(selectedJob.createdAt).toLocaleString()}</div>
            {#if selectedJob.lastError}
              <div><span class="text-base-content/60">Last error:</span><pre class="bg-error/10 text-error text-xs p-2 mt-1 rounded whitespace-pre-wrap">{selectedJob.lastError}</pre></div>
            {/if}
            <div><span class="text-base-content/60">Payload:</span><pre class="bg-base-200 text-xs p-2 mt-1 rounded whitespace-pre-wrap">{tryParsePayload(selectedJob.payload)}</pre></div>
          </div>
          {#if selectedJob.state === 'failed'}
            <button class="btn btn-warning w-full" onclick={() => void retryJob(selectedJob!.id)}>Retry job</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
