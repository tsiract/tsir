<script lang="ts">
  import { api } from '../lib/api.ts';
  import { toast } from '../lib/toast.svelte.ts';

  interface FeatureFlag {
    name: string;
    description?: string;
    active: boolean;
  }

  let data = $state<{ data: FeatureFlag[] } | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let toggling = $state<Record<string, boolean>>({});

  $effect(() => {
    load();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await api<{ data: FeatureFlag[] }>('/api/features');
      data = res;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load feature flags';
      data = null;
    } finally {
      loading = false;
    }
  }

  async function toggleFlag(flag: FeatureFlag) {
    if (toggling[flag.name]) return;
    toggling[flag.name] = true;
    try {
      await api(`/api/features/${encodeURIComponent(flag.name)}`, { method: 'PATCH' });
      toast.success(`"${flag.name}" ${flag.active ? 'disabled' : 'enabled'}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle feature flag');
    } finally {
      toggling[flag.name] = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <div>
      <h1 class="text-2xl font-bold">Feature Flags</h1>
      <p class="text-base-content/70 mt-1 text-sm">Pennant — toggle features across environments.</p>
    </div>
    <button class="btn btn-sm btn-outline" onclick={load}>Refresh</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-8">
      <span class="loading loading-spinner"></span>
    </div>
  {:else if error}
    <div class="alert alert-error">{error}</div>
  {:else if data && data.data.length > 0}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each data.data as flag}
        <div class="card bg-base-200">
          <div class="card-body">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="card-title text-base">{flag.name}</h3>
                {#if flag.description}
                  <p class="text-sm text-base-content/60 mt-1">{flag.description}</p>
                {/if}
              </div>
              <button
                class="btn btn-sm {flag.active ? 'btn-success' : 'btn-ghost'} {toggling[flag.name] ? 'loading' : ''}"
                onclick={() => toggleFlag(flag)}
                disabled={toggling[flag.name]}
              >
                {flag.active ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <p class="text-base-content/60 text-sm">No feature flags defined.</p>
  {/if}
</div>
