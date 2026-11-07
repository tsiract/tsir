<script lang="ts">
  import { api } from '../lib/api.ts';
  import { router, setQuery } from '../lib/router.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import DataTable from '../components/DataTable.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';

  interface Group { id: string; name: string; description: string | null; createdAt: string; }
  interface User { id: string; email: string; displayName: string | null; }
  interface Role { id: string; name: string; description: string | null; }
  interface Permission { id: string; name: string; description: string | null; }

  let data = $state<Group[]>([]);
  let users = $state<User[]>([]);
  let roles = $state<Role[]>([]);
  let permissions = $state<Permission[]>([]);
  let loading = $state(false);
  let showCreate = $state(false);
  let form = $state({ name: '', description: '', userIds: [] as string[], roleIds: [] as string[], permissionIds: [] as string[] });
  let formError = $state<string | null>(null);
  let deleteTarget = $state<Group | null>(null);
  let editingId = $state<string | null>(null);
  let editForm = $state({ name: '', description: '', userIds: [] as string[], roleIds: [] as string[], permissionIds: [] as string[] });
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
    void loadLookups();
  });

  async function load() {
    loading = true;
    try {
      const res = await api<{ data: Group[] }>('/api/groups');
      const q = search.toLowerCase();
      data = q
        ? res.data.filter((g) => g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q))
        : res.data;
    } catch {
      data = [];
    } finally {
      loading = false;
    }
  }

  async function loadLookups() {
    try {
      const [u, r, p] = await Promise.all([
        api<{ data: User[] }>('/api/users').catch(() => ({ data: [] })),
        api<{ data: Role[] }>('/api/roles').catch(() => ({ data: [] })),
        api<{ data: Permission[] }>('/api/permissions').catch(() => ({ data: [] })),
      ]);
      users = u.data;
      roles = r.data;
      permissions = p.data;
    } catch {
      // keep current values
    }
  }

  function onSearch(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    setQuery((q) => {
      if (value) q.set('search', value);
      else q.delete('search');
    });
  }

  function toggleId(list: string[], id: string) {
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
  }

  async function onCreate(e: Event) {
    e.preventDefault();
    formError = null;
    try {
      await api('/api/groups', { method: 'POST', body: JSON.stringify(form) });
      showCreate = false;
      form.name = ''; form.description = '';
      form.userIds = []; form.roleIds = []; form.permissionIds = [];
      toast.success('Group created.');
      await load();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Could not create group';
    }
  }

  function confirmDelete(group: Group) {
    deleteTarget = group;
  }

  async function onEdit(group: Group) {
    editingId = group.id;
    editForm.name = group.name;
    editForm.description = group.description ?? '';
    editForm.userIds = [];
    editForm.roleIds = [];
    editForm.permissionIds = [];
    editError = null;
    try {
      const res = await api<{ users: User[]; roles: Role[]; permissions: Permission[] }>(`/api/groups/${group.id}`);
      editForm.userIds = (res.users ?? []).map((u) => u.id);
      editForm.roleIds = (res.roles ?? []).map((r) => r.id);
      editForm.permissionIds = (res.permissions ?? []).map((p) => p.id);
    } catch {
      // leave empty
    }
  }

  async function saveEdit() {
    if (editingId === null) return;
    editError = null;
    try {
      await api(`/api/groups/${editingId}`, { method: 'PATCH', body: JSON.stringify(editForm) });
      toast.success('Group updated.');
      editingId = null;
      await load();
    } catch (err) {
      editError = err instanceof Error ? err.message : 'Could not update group';
    }
  }

  async function onDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await api(`/api/groups/${id}`, { method: 'DELETE' });
      toast.success('Group deleted.');
      deleteTarget = null;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete group.');
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <h1 class="text-2xl font-bold">Groups</h1>
    <button class="btn btn-primary" onclick={() => (showCreate = !showCreate)}>{showCreate ? 'Cancel' : '+ New group'}</button>
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
          {#if users.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Users</div>
              <div class="flex flex-wrap gap-3">
                {#each users as u}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" checked={form.userIds.includes(u.id)} onchange={() => toggleId(form.userIds, u.id)} />
                    <span class="text-sm">{u.email}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/if}
          {#if roles.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Roles</div>
              <div class="flex flex-wrap gap-3">
                {#each roles as r}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" checked={form.roleIds.includes(r.id)} onchange={() => toggleId(form.roleIds, r.id)} />
                    <span class="text-sm">{r.name}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/if}
          {#if permissions.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Permissions</div>
              <div class="flex flex-wrap gap-3">
                {#each permissions as p}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" checked={form.permissionIds.includes(p.id)} onchange={() => toggleId(form.permissionIds, p.id)} />
                    <span class="text-sm">{p.name}</span>
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
    <input type="search" placeholder="Search groups…" class="input input-bordered" value={search} oninput={onSearch} />
  </div>

  <DataTable columns={columns} rows={data} loading={loading} total={data.length} perPage={data.length || 1} page={1}>
    {#snippet actions(row)}
      {@const g = row as Group}
      <div class="flex gap-1 justify-end">
        <button class="btn btn-ghost btn-xs" onclick={() => onEdit(g)}>Edit</button>
        <button class="btn btn-ghost btn-xs text-error" onclick={() => confirmDelete(g)}>Delete</button>
      </div>
    {/snippet}
  </DataTable>

  {#if editingId !== null}
    <div class="card bg-base-200">
      <div class="card-body space-y-3">
        <h3 class="text-lg font-semibold">Edit group</h3>
        {#if editError}
          <div class="alert alert-error text-sm py-2">{editError}</div>
        {/if}
        <form onsubmit={(e) => { e.preventDefault(); void saveEdit(); }} class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <input type="text" placeholder="Name" class="input input-bordered flex-1 min-w-[200px]" bind:value={editForm.name} required />
            <input type="text" placeholder="Description" class="input input-bordered flex-1 min-w-[200px]" bind:value={editForm.description} />
          </div>
          {#if users.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Users</div>
              <div class="flex flex-wrap gap-3">
                {#each users as u}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" checked={editForm.userIds.includes(u.id)} onchange={() => toggleId(editForm.userIds, u.id)} />
                    <span class="text-sm">{u.email}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/if}
          {#if roles.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Roles</div>
              <div class="flex flex-wrap gap-3">
                {#each roles as r}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" checked={editForm.roleIds.includes(r.id)} onchange={() => toggleId(editForm.roleIds, r.id)} />
                    <span class="text-sm">{r.name}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/if}
          {#if permissions.length > 0}
            <div>
              <div class="label-text font-medium mb-2">Permissions</div>
              <div class="flex flex-wrap gap-3">
                {#each permissions as p}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" checked={editForm.permissionIds.includes(p.id)} onchange={() => toggleId(editForm.permissionIds, p.id)} />
                    <span class="text-sm">{p.name}</span>
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
    title="Delete group?"
    message={`This will permanently delete "${deleteTarget?.name ?? ''}". This cannot be undone.`}
    confirmText="Delete"
    confirmClass="btn-error"
    onConfirm={onDelete}
    onCancel={() => (deleteTarget = null)}
  />
</div>
