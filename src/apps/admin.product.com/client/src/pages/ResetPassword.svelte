<script lang="ts">
  import { router, navigate } from '../lib/router.svelte.ts';
  import { api } from '../lib/api.ts';

  const token = router.query.get('token') ?? '';
  let password = $state('');
  let confirm = $state('');
  let done = $state(false);
  let error = $state<string | null>(null);

  async function onSubmit(e: Event) {
    e.preventDefault();
    error = null;
    if (password !== confirm) {
      error = 'Passwords do not match.';
      return;
    }
    try {
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      done = true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not reset password';
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
        <h1 class="card-title text-xl">Choose a new password</h1>
      </div>
      {#if done}
        <div class="alert alert-success text-sm">Your password has been reset.</div>
        <button class="btn btn-primary w-full mt-4" onclick={() => navigate('/login')}>Back to login</button>
      {:else if !token}
        <div class="alert alert-error text-sm">Missing reset token. Check the link in your email.</div>
        <button class="btn btn-primary w-full mt-4" onclick={() => navigate('/login')}>Back to login</button>
      {:else}
        {#if error}
          <div class="alert alert-error text-sm py-2">{error}</div>
        {/if}
        <form onsubmit={onSubmit} class="flex flex-col gap-4">
          <label class="form-control w-full">
            <span class="label"><span class="label-text">New password</span></span>
            <input type="password" class="input input-bordered w-full" bind:value={password} minlength="8" required autofocus />
          </label>
          <label class="form-control w-full">
            <span class="label"><span class="label-text">Confirm password</span></span>
            <input type="password" class="input input-bordered w-full" bind:value={confirm} minlength="8" required />
          </label>
          <button type="submit" class="btn btn-primary w-full">Reset password</button>
        </form>
      {/if}
    </div>
  </div>
</div>
