<script lang="ts">
  import { api } from '../lib/api.ts';
  import { toast } from '../lib/toast.svelte.ts';

  interface Template { id: string; name: string; subject: string; text: string; html: string | null; createdAt: string; }
  let data = $state<Template[] | null>(null);
  let loading = $state(false);
  let showCreate = $state(false);
  let form = $state({ name: '', subject: '', text: '', html: '' });
  let formError = $state<string | null>(null);
  let editingName = $state<string | null>(null);
  let editForm = $state({ subject: '', text: '', html: '' });
  let editError = $state<string | null>(null);

  $effect(() => { load(); });

  async function load() {
    loading = true;
    try {
      const res = await api<{ data: Template[] }>('/api/email-templates');
      data = res.data;
    } catch { data = null; }
    finally { loading = false; }
  }

  async function onCreate(e: Event) {
    e.preventDefault();
    formError = null;
    try {
      await api('/api/email-templates', { method: 'POST', body: JSON.stringify(form) });
      toast.success('Template created.');
      showCreate = false;
      form.name = ''; form.subject = ''; form.text = ''; form.html = '';
      await load();
    } catch (err) { formError = err instanceof Error ? err.message : 'Could not create template'; }
  }

  function startEdit(row: Template) {
    editingName = row.name;
    editForm.subject = row.subject;
    editForm.text = row.text;
    editForm.html = row.html ?? '';
    editError = null;
  }

  function cancelEdit() {
    editingName = null;
  }

  async function onEdit(e: Event) {
    e.preventDefault();
    if (editingName === null) return;
    editError = null;
    const body: Record<string, unknown> = { subject: editForm.subject, text: editForm.text };
    if (editForm.html.trim() !== '') body.html = editForm.html;
    try {
      await api(`/api/email-templates/${encodeURIComponent(editingName)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      toast.success('Template updated.');
      editingName = null;
      await load();
    } catch (err) { editError = err instanceof Error ? err.message : 'Could not update template'; }
  }

  async function onDelete(name: string) {
    if (!confirm('Delete this template?')) return;
    await api(`/api/email-templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast.success('Template deleted.');
    await load();
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">Email templates</h1>
    <button class="btn btn-primary" onclick={() => (showCreate = !showCreate)}>{showCreate ? 'Cancel' : '+ New template'}</button>
  </div>
  {#if showCreate}
    <div class="card bg-base-200">
      <div class="card-body space-y-2">
        {#if formError}
          <div class="alert alert-error text-sm py-2">{formError}</div>
        {/if}
        <form onsubmit={onCreate} class="flex flex-col gap-2">
          <input type="text" placeholder="Name" class="input input-bordered w-full" bind:value={form.name} required />
          <input type="text" placeholder="Subject" class="input input-bordered w-full" bind:value={form.subject} required />
          <textarea placeholder="Plain text body" class="textarea textarea-bordered w-full" bind:value={form.text} rows="3" required></textarea>
          <textarea placeholder="HTML body (optional)" class="textarea textarea-bordered w-full" bind:value={form.html} rows="3"></textarea>
          <button type="submit" class="btn btn-success self-start">Create</button>
        </form>
      </div>
    </div>
  {/if}
  {#if loading}
    <div class="text-base-content/60">Loading…</div>
  {:else if data}
    <div class="overflow-x-auto">
      <table class="table table-zebra">
        <thead><tr><th>Name</th><th>Subject</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {#each data as row}
            <tr>
              <td><code class="bg-base-200 px-2 py-0.5 rounded text-sm">{row.name}</code></td>
              <td>{row.subject}</td>
              <td>{new Date(row.createdAt).toLocaleDateString()}</td>
              <td class="text-right">
                <button class="btn btn-ghost btn-xs" onclick={() => startEdit(row)}>Edit</button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => onDelete(row.name)}>Delete</button>
              </td>
            </tr>
            {#if editingName === row.name}
              <tr>
                <td colspan="4">
                  <div class="card bg-base-200 p-4">
                    {#if editError}
                      <div class="alert alert-error text-sm py-2 mb-2">{editError}</div>
                    {/if}
                    <form onsubmit={onEdit} class="flex flex-col gap-2">
                      <input type="text" placeholder="Subject" class="input input-bordered w-full" bind:value={editForm.subject} required />
                      <textarea placeholder="Plain text body" class="textarea textarea-bordered w-full" bind:value={editForm.text} rows="3" required></textarea>
                      <textarea placeholder="HTML body (optional)" class="textarea textarea-bordered w-full" bind:value={editForm.html} rows="3"></textarea>
                      <div class="flex gap-2">
                        <button type="submit" class="btn btn-success btn-sm">Save</button>
                        <button type="button" class="btn btn-ghost btn-sm" onclick={cancelEdit}>Cancel</button>
                      </div>
                    </form>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
