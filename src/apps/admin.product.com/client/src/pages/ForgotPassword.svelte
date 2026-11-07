<script lang="ts">
  import { navigate } from '../lib/router.svelte.ts';
  import { api } from '../lib/api.ts';

  let email = $state('');
  let sent = $state(false);
  let error = $state<string | null>(null);

  async function onSubmit(e: Event) {
    e.preventDefault();
    error = null;
    try {
      await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      sent = true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not request reset';
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card bg-base-100 w-full max-w-sm shadow-xl">
    <div class="card-body">
      <div class="flex flex-col items-center mb-4">
        <svg class="w-12 h-12 text-info mb-2" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7 9h18M16 9v15" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" />
          <circle cx="25" cy="24" r="2.5" fill="currentColor" />
        </svg>
        <h1 class="card-title text-xl">Reset password</h1>
      </div>
      {#if sent}
        <div class="alert alert-success text-sm">If an account exists for {email}, a reset link has been sent.</div>
        <button class="btn btn-primary w-full mt-4" onclick={() => navigate('/login')}>Back to login</button>
      {:else}
        {#if error}
          <div class="alert alert-error text-sm py-2">{error}</div>
        {/if}
        <form onsubmit={onSubmit} class="flex flex-col gap-4">
          <label class="form-control w-full">
            <span class="label"><span class="label-text">Email</span></span>
            <input type="email" class="input input-bordered w-full" bind:value={email} required autofocus />
          </label>
          <button type="submit" class="btn btn-primary w-full">Send reset link</button>
        </form>
        <div class="text-center mt-4 text-sm">
          <a href="/login" class="link link-primary" onclick={(e) => { e.preventDefault(); navigate('/login'); }}>Back to login</a>
        </div>
      {/if}
    </div>
  </div>
</div>
