<script lang="ts">
  import { router, setQuery, navigate } from '../lib/router.svelte.ts';
  import { api } from '../lib/api.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import DataTable from '../components/DataTable.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';

  interface UserRow {
    id: string;
    email: string;
    displayName: string | null;
    isSuperAdmin: boolean;
    emailVerified: boolean;
    createdAt: string;
  }

  let data = $state<{ data: UserRow[]; page: number; perPage: number; total: number } | null>(null);
  let loading = $state(false);
  let showCreate = $state(false);
  let deleteTarget = $state<UserRow | null>(null);

  let form = $state({ email: '', password: '', displayName: '', roleIds: [] as string[] });
  let formError = $state<string | null>(null);

  const columns = [
    { key: 'email', label: 'Email' },
    { key: 'displayName', label: 'Display name', render: (v: unknown) => String(v ?? '—') },
    { key: 'emailVerified', label: 'Verified', render: (v: unknown) => v ? '<span class="badge badge-success">✓</span>' : '<span class="badge badge-ghost">✗</span>' },
    { key: 'isSuperAdmin', label: 'Super admin', render: (v: unknown) => v ? '<span class="badge badge-warning">✓</span>' : '<span class="badge badge-ghost">—</span>' },
    { key: 'createdAt', label: 'Created', render: (v: unknown) => new Date(String(v)).toLocaleDateString() },
  ];

  const search = $derived(router.query.get('search') ?? '');
  const page = $derived(Number(router.query.get('page') ?? '1'));
  const perPage = $derived(Number(router.query.get('perPage') ?? '20'));

  $effect(() => {
    void router.query;
    void load();
  });

  async function load() {
    loading = true;
    try {
      const res = await api<{ data: UserRow[]; page: number; perPage: number; total: number }>(
        `/api/users?page=${page}&perPage=${perPage}&search=${encodeURIComponent(search)}`,
      );
      data = res;
    } catch {
      data = null;
    } finally {
      loading = false;
    }
  }

  function onSearch(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    setQuery((q) => {
      if (value) q.set('search', value);
      else q.delete('search');
      q.set('page', '1');
    });
  }

  function onPage(next: number) {
    setQuery((q) => q.set('page', String(next)));
  }

  async function onCreate(e: Event) {
    e.preventDefault();
    formError = null;
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      showCreate = false;
      form.email = ''; form.password = ''; form.displayName = '';
      toast.success('User created.');
      await load();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Could not create user';
    }
  }

  function confirmDelete(user: UserRow) {
    deleteTarget = user;
  }

  async function onDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      toast.success('User deleted.');
      deleteTarget = null;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete user.');
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between flex-wrap gap-3">
    <h1 class="text-2xl font-bold">Users</h1>
    <button class="btn btn-primary" onclick={() => (showCreate = !showCreate)}>
      {showCreate ? 'Cancel' : '+ New user'}
    </button>
  </div>

  {#if showCreate}
    <div class="card bg-base-200">
      <div class="card-body">
        {#if formError}
          <div class="alert alert-error text-sm py-2">{formError}</div>
        {/if}
        <form onsubmit={onCreate} class="flex flex-wrap gap-2">
          <input type="email" placeholder="Email" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.email} required />
          <input type="password" placeholder="Password (min 8 chars)" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.password} minlength="8" required />
          <input type="text" placeholder="Display name" class="input input-bordered flex-1 min-w-[200px]" bind:value={form.displayName} />
          <button type="submit" class="btn btn-success">Create</button>
        </form>
      </div>
    </div>
  {/if}

  <div class="form-control w-full max-w-xs">
    <input type="search" placeholder="Search by email…" class="input input-bordered" value={search} oninput={onSearch} />
  </div>

  <DataTable
    columns={columns}
    rows={data?.data ?? []}
    loading={loading}
    page={data?.page ?? 1}
    perPage={data?.perPage ?? 20}
    total={data?.total ?? 0}
    onPageChange={onPage}
  >
    {#snippet actions(row)}
      {@const u = row as UserRow}
      <div class="flex gap-1 justify-end">
        <button class="btn btn-ghost btn-xs" onclick={() => navigate(`/users/${u.id}`)}>Edit</button>
        <button class="btn btn-ghost btn-xs text-error" onclick={() => confirmDelete(u)}>Delete</button>
      </div>
    {/snippet}
  </DataTable>

  <ConfirmDialog
    open={deleteTarget !== null}
    title="Delete user?"
    message={`This will permanently delete "${deleteTarget?.email ?? ''}". This cannot be undone.`}
    confirmText="Delete"
    confirmClass="btn-error"
    onConfirm={onDelete}
    onCancel={() => (deleteTarget = null)}
  />
</div>
