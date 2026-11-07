<script lang="ts">
  import { navigate } from '../lib/router.svelte.ts';
  import { api } from '../lib/api.ts';
  import { auth } from '../lib/auth.svelte.ts';

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);
  let done = $state(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    error = null;
    loading = true;
    try {
      await api('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      done = true;
      // Mark the app as installed so the redirect guard doesn't bounce us
      // back to /setup when we navigate to /login.
      auth.installed = true;
      setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Setup failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card bg-base-100 w-full max-w-md shadow-xl">
    <div class="card-body">
      <div class="flex flex-col items-center mb-4">
        <svg class="w-14 h-14 text-info mb-2" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7 9h18M16 9v15" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" />
          <circle cx="25" cy="24" r="2.5" fill="currentColor" />
        </svg>
        <h1 class="card-title text-xl">Set up Tsir Admin</h1>
        <p class="text-sm opacity-70">Create the first super-admin account.</p>
      </div>
      {#if done}
        <div class="alert alert-success">Admin created. Redirecting to login…</div>
      {:else}
        {#if error}
          <div class="alert alert-error text-sm py-2">{error}</div>
        {/if}
        <form onsubmit={onSubmit} class="flex flex-col gap-4">
          <label class="form-control w-full">
            <span class="label"><span class="label-text">Email</span></span>
            <input type="email" class="input input-bordered w-full" bind:value={email} required autofocus />
          </label>
          <label class="form-control w-full">
            <span class="label"><span class="label-text">Password</span></span>
            <input type="password" class="input input-bordered w-full" bind:value={password} minlength="8" required />
          </label>
          <button type="submit" class="btn btn-primary w-full" disabled={loading}>
            {loading ? 'Installing…' : 'Install admin'}
          </button>
        </form>
      {/if}
    </div>
  </div>
</div>
