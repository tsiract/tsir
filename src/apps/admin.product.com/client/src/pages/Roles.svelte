<script lang="ts">
  import { api } from '../lib/api.ts';
  import { router, setQuery } from '../lib/router.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import DataTable from '../components/DataTable.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';

  interface Role { id: string; name: string; description: string | null; createdAt: string; }
  interface Permission { id: string; name: string; description: string | null; }

  let data = $state<Role[]>([]);
  let permissions = $state<Permission[]>([]);
  let loading = $state(false);
  let showCreate = $state(false);
  let form = $state({ name: '', description: '', permissionIds: [] as string[] });
  let formError = $state<string | null>(null);
  let deleteTarget = $state<Role | null>(null);
  let editingId = $state<string | null>(null);
  let editForm = $state({ name: '', description: '', permissionIds: [] as string[] });
  let editError = $state<string | null>(null);

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'description', label: 'Description', render: (v: unknown) => String(v ?? '—') },
    { key: 'createdAt', label: 'Created', render: (v: unknown) => new Date(String(v)).toLocaleDateString() },
  ];

  const search = $derived(router.query.get('search') ?? '');

  $effect(() => {
    void router.query;
    void load();
    void loadPermissions();
  });

  async function load() {
    loading = true;
    try {
      const res = await api<{ data: Role[] }>('/api/roles');
      const q = search.toLowerCase();
      data = q
        ? res.data.filter((r) => r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q))
        : res.data;
    } catch {
      data = [];
    } finally {
      loading = false;
    }
  }

  async function loadPermissions() {
    try {
      const res = await api<{ data: Permission[] }>('/api/permissions');
      permissions = res.data;
    } catch {
      permissions = [];
    }
  }

  function onSearch(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    setQuery((q) => {
      if (value) q.set('search', value);
      else q.delete('search');
    });
  }

  function toggleFormPermission(id: string, isEdit: boolean) {
    const list = isEdit ? editForm.permissionIds : form.permissionIds;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
  }

  async function onCreate(e: Event) {
    e.preventDefault();
    formError = null;
    try {
      await api('/api/roles', { method: 'POST', body: JSON.stringify(form) });
      showCreate = false;
      form.name = ''; form.description = ''; form.permissionIds = [];
      toast.success('Role created.');
      await load();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Could not create role';
    }
  }

  function confirmDelete(role: Role) {
    deleteTarget = role;
  }

  async function onEdit(role: Role) {
    editingId = role.id;
    editForm.name = role.name;
    editForm.description = role.description ?? '';
    editForm.permissionIds = [];
    editError = null;
    // Load existing permissions for this role.
    try {
      const res = await api<{ permissions: Permission[] }>(`/api/roles/${role.id}`);
      editForm.permissionIds = (res.permissions ?? []).map((p) => p.id);
    } catch {
      editForm.permissionIds = [];
    }
  }

  async function saveEdit() {
    if (editingId === null) return;
    editError = null;
    try {
      await api(`/api/roles/${editingId}`, { method: 'PATCH', body: JSON.stringify(editForm) });
      toast.success('Role updated.');
      editingId = null;
      await load();
    } catch (err) {
      editError = err instanceof Error ? err.message : 'Could not update role';
    }
  }

  async function onDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await api(`/api/roles/${id}`, { method: 'DELETE' });
      toast.success('Role deleted.');
      deleteTarget = null;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete role.');
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <h1 class="text-2xl font-bold">Roles</h1>
    <button class="btn btn-primary" onclick={() => (showCreate = !showCreate)}>{showCreate ? 'Cancel' : '+ New role'}</button>
  </div>

  {#if showCreate}
    <div class="card bg-base-200">
      <div class="card-body space-y-3">
        {#if formError}
          <div class="alert alert-error text-sm py-2">{formError}</div>
        {/if}
        <form onsubmit={onCreate} class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <input type="text" placeholder="Name" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.name} required />
            <input type="text" placeholder="Description" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.description} />
          </div>
          {#if permissions.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Permissions</div>
              <div class="flex flex-wrap gap-3">
                {#each permissions as perm}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      checked={form.permissionIds.includes(perm.id)}
                      onchange={() => toggleFormPermission(perm.id, false)}
                    />
                    <span class="text-sm">{perm.name}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/if}
          <button type="submit" class="btn btn-success">Create</button>
        </form>
      </div>
    </div>
  {/if}

  <div class="form-control w-full max-w-xs">
    <input type="search" placeholder="Search roles…" class="input input-bordered" value={search} oninput={onSearch} />
  </div>

  <DataTable columns={columns} rows={data} loading={loading} total={data.length} perPage={data.length || 1} page={1}>
    {#snippet actions(row)}
      {@const r = row as Role}
      <div class="flex gap-1 justify-end">
        <button class="btn btn-ghost btn-xs" onclick={() => onEdit(r)}>Edit</button>
        <button class="btn btn-ghost btn-xs text-error" onclick={() => confirmDelete(r)}>Delete</button>
      </div>
    {/snippet}
  </DataTable>

  {#if editingId !== null}
    <div class="card bg-base-200">
      <div class="card-body space-y-3">
        <h3 class="text-lg font-semibold">Edit role</h3>
        {#if editError}
          <div class="alert alert-error text-sm py-2">{editError}</div>
        {/if}
        <form onsubmit={(e) => { e.preventDefault(); void saveEdit(); }} class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <input type="text" placeholder="Name" class="input input-bordered flex-1 min-w-[200px]" bind:value={editForm.name} required />
            <input type="text" placeholder="Description" class="input input-bordered flex-1 min-w-[200px]" bind:value={editForm.description} />
          </div>
          {#if permissions.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Permissions</div>
              <div class="flex flex-wrap gap-3">
                {#each permissions as perm}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      checked={editForm.permissionIds.includes(perm.id)}
                      onchange={() => toggleFormPermission(perm.id, true)}
                    />
                    <span class="text-sm">{perm.name}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/if}
          <div class="flex gap-2">
            <button type="submit" class="btn btn-success">Save</button>
            <button type="button" class="btn btn-ghost" onclick={() => (editingId = null)}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  <ConfirmDialog
    open={deleteTarget !== null}
    title="Delete role?"
    message={`This will permanently delete "${deleteTarget?.name ?? ''}". This cannot be undone.`}
    confirmText="Delete"
    confirmClass="btn-error"
    onConfirm={onDelete}
    onCancel={() => (deleteTarget = null)}
  />
</div>
