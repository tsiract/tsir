<script lang="ts">
  import { router, navigate, registerRoutes } from './lib/router.svelte.ts';
  import { bootstrap, auth } from './lib/auth.svelte.ts';

  import Layout from './components/Layout.svelte';
  import Login from './pages/Login.svelte';
  import Setup from './pages/Setup.svelte';
  import Dashboard from './pages/Dashboard.svelte';
  import Users from './pages/Users.svelte';
  import UserDetail from './pages/UserDetail.svelte';
  import Roles from './pages/Roles.svelte';
  import Permissions from './pages/Permissions.svelte';
  import Groups from './pages/Groups.svelte';
  import I18n from './pages/I18n.svelte';
  import EmailTemplates from './pages/EmailTemplates.svelte';
  import Requests from './pages/Requests.svelte';
  import Queues from './pages/Queues.svelte';
  import FeatureFlags from './pages/FeatureFlags.svelte';
  import ForgotPassword from './pages/ForgotPassword.svelte';
  import ResetPassword from './pages/ResetPassword.svelte';

  registerRoutes([
    { path: '/login', component: Login },
    { path: '/setup', component: Setup },
    { path: '/forgot-password', component: ForgotPassword },
    { path: '/reset-password', component: ResetPassword },
    { path: '/', component: Dashboard },
    { path: '/users', component: Users },
    { path: '/users/:id', component: UserDetail },
    { path: '/roles', component: Roles },
    { path: '/permissions', component: Permissions },
    { path: '/groups', component: Groups },
    { path: '/i18n', component: I18n },
    { path: '/email-templates', component: EmailTemplates },
    { path: '/requests', component: Requests },
    { path: '/queues', component: Queues },
    { path: '/features', component: FeatureFlags },
  ]);

  $effect(() => {
    void bootstrap();
  });

  // Redirect based on install/auth state.
  $effect(() => {
    if (!auth.bootstrapped) return; // still booting
    const path = router.current?.path ?? location.pathname;
    if (!auth.installed && path !== '/setup') {
      navigate('/setup');
      return;
    }
    if (auth.installed && !auth.user && path !== '/login' && path !== '/setup' && path !== '/forgot-password' && path !== '/reset-password') {
      navigate('/login');
      return;
    }
    if (auth.installed && auth.user && (path === '/login' || path === '/setup')) {
      navigate('/');
    }
  });

  const publicPaths = new Set(['/login', '/setup', '/forgot-password', '/reset-password']);
  const isPublic = $derived(publicPaths.has(router.current?.path ?? ''));
</script>

{#if !auth.bootstrapped}
  <div class="min-h-screen flex items-center justify-center gap-3 text-base-content/60">
    <span class="loading loading-spinner loading-lg"></span>
    <span>Loading…</span>
  </div>
{:else if isPublic}
  {#if router.current}
    <svelte:component this={router.current.component} />
  {/if}
{:else if auth.user}
  <Layout>
    {#if router.current}
      <svelte:component this={router.current.component} />
    {:else}
      <div class="text-center py-12">
        <h1 class="text-4xl font-bold opacity-50">404</h1>
        <p class="mt-2 text-base-content/60">Page not found.</p>
      </div>
    {/if}
  </Layout>
{/if}
