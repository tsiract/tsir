<script lang="ts">
  import { navigate } from '../lib/router.svelte.ts';
  import { api, ApiError } from '../lib/api.ts';
  import { auth } from '../lib/auth.svelte.ts';

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);

  // Captcha token — populated by the Turnstile widget callback.
  let captchaToken = '';

  async function onSubmit(e: Event) {
    e.preventDefault();
    error = null;
    loading = true;
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, captchaToken }),
      });
      auth.user = await api('/api/auth/me');
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === 'object') {
        const code = (err.body as { error?: string }).error;
        if (code === 'invalid_credentials') {
          error = 'Invalid credentials';
        } else if (code) {
          error = code.replace(/_/g, ' ');
        } else {
          error = 'Login failed';
        }
      } else {
        error = err instanceof Error ? err.message : 'Login failed';
      }
    } finally {
      loading = false;
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
        <h1 class="card-title text-xl">Sign in to Tsir Admin</h1>
      </div>
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
          <input type="password" class="input input-bordered w-full" bind:value={password} required />
        </label>
        <!-- Cloudflare Turnstile widget placeholder. When CAPTCHA_SITE_KEY is set,
             the server returns it via /api/auth/captcha and this div becomes the
             widget. For local dev with CAPTCHA_DISABLED=true, it stays empty. -->
        <div id="cf-turnstile"></div>
        <button type="submit" class="btn btn-primary w-full" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div class="text-center mt-4 text-sm">
        <a href="/forgot-password" class="link link-primary" onclick={(e) => { e.preventDefault(); navigate('/forgot-password'); }}>
          Forgot password?
        </a>
      </div>
    </div>
  </div>
</div>
