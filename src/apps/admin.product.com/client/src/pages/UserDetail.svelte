<script lang="ts">
  import { router, navigate } from '../lib/router.svelte.ts';
  import { api } from '../lib/api.ts';

  interface UserDetail {
    id: string;
    email: string;
    displayName: string | null;
    emailVerified: boolean;
    isSuperAdmin: boolean;
    createdAt: string;
    updatedAt: string;
  }

  interface Role {
    id: string;
    name: string;
    description: string | null;
  }

  let user = $state<UserDetail | null>(null);
  let roles = $state<Role[]>([]);
  let userRoleIds = $state<string[]>([]);
  let permissions = $state<string[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saveError = $state<string | null>(null);

  // Editable form fields.
  let form = $state({
    email: '',
    displayName: '',
    password: '',
    isSuperAdmin: false,
    roleIds: [] as string[],
  });

  function formToUpdate(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      email: form.email,
      displayName: form.displayName === '' ? null : form.displayName,
      isSuperAdmin: form.isSuperAdmin,
      roleIds: form.roleIds,
    };
    if (form.password !== '') body.password = form.password;
    return body;
  }

  async function load() {
    loading = true;
    error = null;
    const id = router.current?.params.id;
    if (id === undefined) {
      error = 'No user id in URL.';
      loading = false;
      return;
    }
    try {
      const [u, r, ur, up] = await Promise.all([
        api<UserDetail>(`/api/users/${id}`),
        api<{ data: Role[] }>('/api/roles'),
        api<{ data: Role[] }>(`/api/users/${id}/roles`).catch(() => ({ data: [] as Role[] })),
        api<{ data: string[] }>(`/api/users/${id}/permissions`).catch(() => ({ data: [] as string[] })),
      ]);
      user = u;
      roles = r.data;
      userRoleIds = ur.data.map((role) => role.id);
      permissions = up.data;
      form.email = u.email;
      form.displayName = u.displayName ?? '';
      form.isSuperAdmin = u.isSuperAdmin;
      form.roleIds = [...userRoleIds];
      form.password = '';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load user.';
      user = null;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void router.current;
    void load();
  });

  async function onSave(e: Event) {
    e.preventDefault();
    if (!user) return;
    saving = true;
    saveError = null;
    try {
      await api(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify(formToUpdate()),
      });
      // Reload to reflect server-side state.
      await load();
    } catch (err) {
      saveError = err instanceof Error ? err.message : 'Could not update user.';
    } finally {
      saving = false;
    }
  }

  function toggleRole(id: string) {
    if (form.roleIds.includes(id)) {
      form.roleIds = form.roleIds.filter((rid) => rid !== id);
    } else {
      form.roleIds = [...form.roleIds, id];
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <button class="btn btn-ghost btn-sm" onclick={() => navigate('/users')} aria-label="Back to users">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
        Back
      </button>
      <h1 class="text-2xl font-bold">Edit user</h1>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 text-base-content/60">
      <span class="loading loading-spinner loading-sm"></span>
      Loading user…
    </div>
  {:else if error}
    <div class="alert alert-error">{error}</div>
  {:else if user}
    <form onsubmit={onSave} class="card bg-base-200">
      <div class="card-body space-y-4">
        {#if saveError}
          <div class="alert alert-error text-sm py-2">{saveError}</div>
        {/if}

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="form-control w-full">
            <span class="label"><span class="label-text">Email</span></span>
            <input type="email" class="input input-bordered" bind:value={form.email} required />
          </label>

          <label class="form-control w-full">
            <span class="label"><span class="label-text">Display name</span></span>
            <input type="text" class="input input-bordered" bind:value={form.displayName} placeholder="(optional)" />
          </label>
        </div>

        <label class="form-control w-full">
          <span class="label"><span class="label-text">New password</span><span class="label-text-alt">Leave blank to keep current</span></span>
          <input type="password" class="input input-bordered" bind:value={form.password} minlength="8" placeholder="••••••••" />
        </label>

        <div class="flex items-center gap-3">
          <input
            type="checkbox"
            class="toggle toggle-primary"
            checked={form.isSuperAdmin}
            onchange={(e) => (form.isSuperAdmin = (e.target as HTMLInputElement).checked)}
          />
          <span class="label-text">Super administrator</span>
        </div>

        <div>
          <span class="label-text font-medium">Roles</span>
          {#if roles.length === 0}
            <p class="text-sm text-base-content/60 mt-1">No roles defined yet.</p>
          {:else}
            <div class="flex flex-wrap gap-3 mt-2">
              {#each roles as role}
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={form.roleIds.includes(role.id)}
                    onchange={() => toggleRole(role.id)}
                  />
                  <span>{role.name}</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>

        <div>
          <span class="label-text font-medium">Effective permissions</span>
          <span class="label-text-alt ml-2">(from roles &amp; groups)</span>
          {#if permissions.length === 0}
            <p class="text-sm text-base-content/60 mt-1">No permissions.</p>
          {:else}
            <div class="flex flex-wrap gap-2 mt-2">
              {#each permissions as perm}
                <span class="badge badge-outline">{perm}</span>
              {/each}
            </div>
          {/if}
        </div>

        <div class="text-xs text-base-content/50 border-t border-base-300 pt-3">
          <div>Email verified: {user.emailVerified ? 'Yes' : 'No'}</div>
          <div>Created: {new Date(user.createdAt).toLocaleString()}</div>
          <div>Last updated: {new Date(user.updatedAt).toLocaleString()}</div>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-ghost" onclick={() => navigate('/users')}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={saving}>
            {#if saving}<span class="loading loading-spinner loading-xs"></span>{/if}
            Save changes
          </button>
        </div>
      </div>
    </form>
  {/if}
</div>
