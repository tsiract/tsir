<script lang="ts">
  import { api } from '../lib/api.ts';

  interface Key { id: string; key: string; namespace: string; }
  let data = $state<Key[] | null>(null);
  let loading = $state(false);
  let showCreate = $state(false);
  let form = $state({ key: '', value: '', namespace: 'common' });
  let formError = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let editValue = $state('');
  let editingLocale = $state('en');

  $effect(() => { load(); });

  async function load() {
    loading = true;
    try {
      const res = await api<{ data: Key[] }>('/api/i18n/keys');
      data = res.data;
    } catch { data = null; }
    finally { loading = false; }
  }

  async function onCreate(e: Event) {
    e.preventDefault();
    formError = null;
    try {
      await api('/api/i18n/keys', { method: 'POST', body: JSON.stringify(form) });
      showCreate = false;
      form.key = ''; form.value = '';
      await load();
    } catch (err) { formError = err instanceof Error ? err.message : 'Could not create key'; }
  }

  async function onDelete(id: string) {
    if (!confirm('Delete this translation key?')) return;
    await api(`/api/i18n/keys/${id}`, { method: 'DELETE' });
    await load();
  }

  async function onEdit(id: string) {
    editingId = id;
    const res = await api<{ data: { id: string; locale: string; value: string }[] }>(`/api/i18n/keys/${id}/translations`);
    const en = res.data.find((t) => t.locale === editingLocale);
    editValue = en?.value ?? '';
  }

  async function saveEdit() {
    if (editingId === null) return;
    await api(`/api/i18n/keys/${editingId}/translations/${editingLocale}`, {
      method: 'PATCH',
      body: JSON.stringify({ value: editValue }),
    });
    editingId = null;
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">Translations</h1>
    <button class="btn btn-primary" onclick={() => (showCreate = !showCreate)}>{showCreate ? 'Cancel' : '+ New key'}</button>
  </div>
  {#if showCreate}
    <div class="card bg-base-200">
      <div class="card-body">
        {#if formError}
          <div class="alert alert-error text-sm py-2">{formError}</div>
        {/if}
        <form onsubmit={onCreate} class="flex flex-wrap gap-2">
          <input type="text" placeholder="Key (e.g. common.save)" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.key} required />
          <input type="text" placeholder="English value" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.value} />
          <button type="submit" class="btn btn-success">Create</button>
        </form>
      </div>
    </div>
  {/if}
  {#if loading}
    <div class="text-base-content/60">Loading…</div>
  {:else if data}
    <div class="overflow-x-auto">
      <table class="table table-zebra">
        <thead><tr><th>Key</th><th>Namespace</th><th></th></tr></thead>
        <tbody>
          {#each data as row}
            <tr>
              <td><code class="bg-base-200 px-2 py-0.5 rounded text-sm">{row.key}</code></td>
              <td>{row.namespace}</td>
              <td>
                <div class="flex gap-1">
                  <button class="btn btn-ghost btn-xs" onclick={() => onEdit(row.id)}>Edit</button>
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => onDelete(row.id)}>Delete</button>
                </div>
              </td>
            </tr>
            {#if editingId === row.id}
              <tr><td colspan="3">
                <div class="flex gap-2 py-2">
                  <input type="text" class="input input-bordered flex-1" bind:value={editValue} placeholder="Translation" />
                  <button class="btn btn-primary btn-sm" onclick={saveEdit}>Save</button>
                  <button class="btn btn-ghost btn-sm" onclick={() => (editingId = null)}>Cancel</button>
                </div>
              </td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
