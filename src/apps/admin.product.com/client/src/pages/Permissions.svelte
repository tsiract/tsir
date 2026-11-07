<script lang="ts">
  import { api } from '../lib/api.ts';
  import { router, setQuery } from '../lib/router.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import DataTable from '../components/DataTable.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';

  interface Permission { id: string; name: string; description: string | null; createdAt: string; }

  let data = $state<Permission[]>([]);
  let loading = $state(false);
  let showCreate = $state(false);
  let form = $state({ name: '', description: '' });
  let formError = $state<string | null>(null);
  let deleteTarget = $state<Permission | null>(null);

  const columns = [
    { key: 'name', label: 'Name', render: (v: unknown) => `<code class="bg-base-200 px-2 py-0.5 rounded text-sm">${String(v)}</code>` },
    { key: 'description', label: 'Description', render: (v: unknown) => String(v ?? '—') },
    { key: 'createdAt', label: 'Created', render: (v: unknown) => new Date(String(v)).toLocaleDateString() },
  ];

  const search = $derived(router.query.get('search') ?? '');

  $effect(() => {
    void router.query;
    void load();
  });

  async function load() {
    loading = true;
    try {
      const res = await api<{ data: Permission[] }>('/api/permissions');
      const q = search.toLowerCase();
      data = q
        ? res.data.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
        : res.data;
    } catch {
      data = [];
    } finally {
      loading = false;
    }
  }

  function onSearch(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    setQuery((q) => {
      if (value) q.set('search', value);
      else q.delete('search');
    });
  }

  async function onCreate(e: Event) {
    e.preventDefault();
    formError = null;
    try {
      await api('/api/permissions', { method: 'POST', body: JSON.stringify(form) });
      showCreate = false;
      form.name = ''; form.description = '';
      toast.success('Permission created.');
      await load();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Could not create permission';
    }
  }

  function confirmDelete(perm: Permission) {
    deleteTarget = perm;
  }

  async function onDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await api(`/api/permissions/${id}`, { method: 'DELETE' });
      toast.success('Permission deleted.');
      deleteTarget = null;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete permission.');
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <h1 class="text-2xl font-bold">Permissions</h1>
    <button class="btn btn-primary" onclick={() => (showCreate = !showCreate)}>{showCreate ? 'Cancel' : '+ New permission'}</button>
  </div>

  {#if showCreate}
    <div class="card bg-base-200">
      <div class="card-body">
        {#if formError}
          <div class="alert alert-error text-sm py-2">{formError}</div>
        {/if}
        <form onsubmit={onCreate} class="flex flex-wrap gap-2">
          <input type="text" placeholder="Name (e.g. users.create)" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.name} required />
          <input type="text" placeholder="Description" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.description} />
          <button type="submit" class="btn btn-success">Create</button>
        </form>
      </div>
    </div>
  {/if}

  <div class="form-control w-full max-w-xs">
    <input type="search" placeholder="Search permissions…" class="input input-bordered" value={search} oninput={onSearch} />
  </div>

  <DataTable columns={columns} rows={data} loading={loading} total={data.length} perPage={data.length || 1} page={1}>
    {#snippet actions(row)}
      {@const p = row as Permission}
      <div class="flex gap-1 justify-end">
        <button class="btn btn-ghost btn-xs text-error" onclick={() => confirmDelete(p)}>Delete</button>
      </div>
    {/snippet}
  </DataTable>

  <ConfirmDialog
    open={deleteTarget !== null}
    title="Delete permission?"
    message={`This will permanently delete "${deleteTarget?.name ?? ''}". This cannot be undone.`}
    confirmText="Delete"
    confirmClass="btn-error"
    onConfirm={onDelete}
    onCancel={() => (deleteTarget = null)}
  />
</div>
