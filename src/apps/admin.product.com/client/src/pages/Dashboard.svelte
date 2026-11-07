<script lang="ts">
  import { auth } from '../lib/auth.svelte.ts';
  import { api } from '../lib/api.ts';
  import { navigate } from '../lib/router.svelte.ts';

  interface MetricPoint {
    name: string;
    type: string;
    value: number;
    labels?: Record<string, string>;
  }

  let points = $state<MetricPoint[] | null>(null);
  let loading = $state(false);

  $effect(() => {
    void load();
  });

  async function load() {
    loading = true;
    try {
      const res = await api<{ points: MetricPoint[] }>('/system/metrics');
      points = res.points;
    } catch {
      points = null;
    } finally {
      loading = false;
    }
  }

  function point(name: string): number | null {
    if (!points) return null;
    const p = points.find((pt) => pt.name === name);
    return p?.value ?? null;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold">Welcome, {auth.user?.displayName || auth.user?.email}</h1>
    <p class="text-base-content/70 mt-1">This is the Tsir Admin dashboard. Use the sidebar to manage users, roles, permissions, groups, translations, and email templates.</p>
  </div>

  {#if auth.user?.isSuperAdmin}
    <div class="badge badge-warning badge-lg">Super administrator</div>
  {/if}

  <!-- Quick actions -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    <div class="card bg-base-200 cursor-pointer" onclick={() => navigate('/requests')}>
      <div class="card-body">
        <h3 class="card-title text-base">Request Logs</h3>
        <p class="text-sm text-base-content/60">Telescope-style request audit</p>
      </div>
    </div>
    <div class="card bg-base-200 cursor-pointer" onclick={() => navigate('/queues')}>
      <div class="card-body">
        <h3 class="card-title text-base">Queue Monitor</h3>
        <p class="text-sm text-base-content/60">Horizon-style job monitoring</p>
      </div>
    </div>
    <div class="card bg-base-200 cursor-pointer" onclick={() => navigate('/i18n')}>
      <div class="card-body">
        <h3 class="card-title text-base">Translations</h3>
        <p class="text-sm text-base-content/60">i18n keys and locales</p>
      </div>
    </div>
  </div>

  <!-- Metrics -->
  <div>
    <h2 class="text-lg font-semibold mb-3">Metrics</h2>
    {#if loading}
      <div class="flex justify-center py-8">
        <span class="loading loading-spinner"></span>
      </div>
    {:else if points && points.length > 0}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        {#each points as p}
          <div class="card bg-base-200">
            <div class="card-body py-3">
              <p class="text-xs text-base-content/60 uppercase">{p.name}</p>
              <p class="text-2xl font-bold">{p.value}</p>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="text-base-content/60 text-sm">No metrics recorded yet.</p>
    {/if}
  </div>
</div>
