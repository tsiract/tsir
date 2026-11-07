<script lang="ts">
  import { router, navigate } from '../lib/router.svelte.ts';
  import { auth, clearUser } from '../lib/auth.svelte.ts';
  import { api } from '../lib/api.ts';
  import { toggleTheme, isDark } from '../lib/theme.svelte.ts';
  import Toast from './Toast.svelte';

  const STORAGE_KEY = 'tsir-admin-sidebar-collapsed';
  let collapsed = $state(localStorage.getItem(STORAGE_KEY) === 'true');
  let userMenuOpen = $state(false);

  function toggleSidebar() {
    collapsed = !collapsed;
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      /* storage may be unavailable */
    }
  }

  async function onLogout() {
    await api('/api/auth/logout', { method: 'POST' });
    clearUser();
    userMenuOpen = false;
    navigate('/login');
  }

  // Simple stroke-based icons (24x24, 1.75 stroke-width).
  const icons = {
    dashboard: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    users: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 100-8 4 4 0 000 8zm6 3a3 3 0 100-6 3 3 0 000 6z',
    roles: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    permissions: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    groups: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    translations: 'M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129',
    email: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    requests: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    queues: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    features: 'M13 10V3L4 14h7v7l9-11h-7z',
  };

  const nav = [
    { label: 'Dashboard', path: '/', icon: icons.dashboard },
    { label: 'Users', path: '/users', icon: icons.users },
    { label: 'Roles', path: '/roles', icon: icons.roles },
    { label: 'Permissions', path: '/permissions', icon: icons.permissions },
    { label: 'Groups', path: '/groups', icon: icons.groups },
    { label: 'Translations', path: '/i18n', icon: icons.translations },
    { label: 'Email templates', path: '/email-templates', icon: icons.email },
    { label: 'Request Logs', path: '/requests', icon: icons.requests },
    { label: 'Queue Monitor', path: '/queues', icon: icons.queues },
    { label: 'Feature Flags', path: '/features', icon: icons.features },
  ];

  function isActive(path: string): boolean {
    const current = router.current?.path ?? '';
    if (path === '/') return current === '/';
    return current === path || current.startsWith(`${path}/`);
  }

  // Known dynamic route segments map to human-readable labels.
  const dynamicLabels: Record<string, string> = {
    ':id': 'Detail',
  };

  // Breadcrumbs derived from the current pathname.
  const breadcrumbs = $derived.by(() => {
    const pathname = router.pathname;
    const crumbs: { label: string; path: string }[] = [{ label: 'Home', path: '/' }];
    if (pathname && pathname !== '/') {
      const routeParts = router.current?.path?.split('/').filter(Boolean) ?? [];
      const pathParts = pathname.split('/').filter(Boolean);
      let acc = '';
      for (let i = 0; i < pathParts.length; i++) {
        acc += `/${pathParts[i]}`;
        const routeSeg = routeParts[i];
        const isDynamic = routeSeg?.startsWith(':') ?? false;
        const navItem = nav.find((n) => n.path === acc);
        const label = navItem?.label
          ?? (isDynamic ? dynamicLabels[routeSeg] ?? 'Detail' : decodeURIComponent(pathParts[i]));
        crumbs.push({ label, path: acc });
      }
    }
    return crumbs;
  });

  const pageTitle = $derived.by(() => {
    const current = router.current?.path ?? '';
    const navItem = nav.find((n) => n.path === current);
    if (navItem) return navItem.label;
    if (current === '/') return 'Dashboard';
    const lastSeg = current.split('/').filter(Boolean).pop() ?? 'Page';
    return dynamicLabels[lastSeg] ?? lastSeg;
  });

  function handleNavClick(e: MouseEvent, path: string) {
    e.preventDefault();
    navigate(path);
  }

  // Close user menu when clicking outside.
  function onDocClick(e: MouseEvent) {
    const target = e.target as Node;
    const wrapper = document.getElementById('user-menu-wrapper');
    if (wrapper && !wrapper.contains(target)) userMenuOpen = false;
  }

  $effect(() => {
    if (userMenuOpen) {
      document.addEventListener('click', onDocClick);
      return () => document.removeEventListener('click', onDocClick);
    }
  });
</script>

<div class="drawer lg:drawer-open">
  <input id="sidebar-drawer" type="checkbox" class="drawer-toggle" />
  <div class="drawer-content flex flex-col">
    <!-- Top navbar -->
    <header class="navbar bg-base-200 border-b border-base-300 sticky top-0 z-30">
      <div class="flex-none lg:hidden">
        <label for="sidebar-drawer" class="btn btn-square btn-ghost" aria-label="Open navigation">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
        </label>
      </div>

      <div class="flex-1 min-w-0">
        <div class="text-sm breadcrumbs">
          <ul>
            {#each breadcrumbs as crumb, i}
              <li>
                {#if i < breadcrumbs.length - 1}
                  <a href={crumb.path} onclick={(e) => handleNavClick(e, crumb.path)}>{crumb.label}</a>
                {:else}
                  <span class="text-base-content/80 font-medium">{crumb.label}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      </div>

      <div class="flex-none flex items-center gap-1">
        <button
          class="btn btn-square btn-ghost"
          onclick={toggleTheme}
          aria-label={`Switch to ${isDark() ? 'Silk light' : 'Abyss dark'} theme`}
          title={`${isDark() ? 'Abyss dark' : 'Silk light'} — click to switch`}
        >
          {#if isDark()}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>
          {/if}
        </button>

        <div id="user-menu-wrapper" class="dropdown dropdown-end">
          <button
            class="btn btn-ghost btn-sm gap-2"
            tabindex={0}
            onclick={() => (userMenuOpen = !userMenuOpen)}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
          >
            <div class="avatar placeholder">
              <div class="bg-primary text-primary-content rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">
                {(auth.user?.displayName ?? auth.user?.email ?? '?').slice(0, 1).toUpperCase()}
              </div>
            </div>
            <span class="hidden sm:block max-w-[12rem] truncate text-sm">{auth.user?.email}</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-4 h-4 stroke-current opacity-60"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
          </button>
          {#if userMenuOpen}
            <ul class="dropdown-content menu bg-base-100 rounded-box z-50 w-56 p-2 shadow-lg border border-base-300" role="menu">
              <li class="menu-title px-3 py-1">
                <span class="text-xs truncate">{auth.user?.email}</span>
              </li>
              {#if auth.user?.displayName}
                <li class="px-3 pb-2">
                  <span class="text-sm text-base-content/70 truncate">{auth.user.displayName}</span>
                </li>
              {/if}
              <li>
                <button class="justify-start" onclick={onLogout} role="menuitem">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-4 h-4 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
                  Sign out
                </button>
              </li>
            </ul>
          {/if}
        </div>
      </div>
    </header>

    <main class="p-4 lg:p-8">
      <slot />
    </main>
  </div>

  <div class="drawer-side z-40">
    <label for="sidebar-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
    <aside
      class="tsir-sidebar bg-base-200 text-base-content min-h-full flex flex-col"
      style={`--tsir-sidebar-width: ${collapsed ? '4rem' : '16rem'}`}
    >
      <div class="flex items-center gap-2 px-3 h-16 border-b border-base-300">
        <svg class="w-8 h-8 text-info flex-shrink-0" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7 9h18M16 9v15" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" />
          <circle cx="25" cy="24" r="2.5" fill="currentColor" />
        </svg>
        {#if !collapsed}
          <span class="text-lg font-bold truncate">Tsir Admin</span>
        {/if}
      </div>

      <ul class="menu menu-md flex-1 px-2 py-3">
        {#each nav as item}
          <li class="my-0.5">
            <a
              class="flex items-center {collapsed ? 'justify-center' : ''} {isActive(item.path) ? 'active' : ''}"
              href={item.path}
              onclick={(e) => handleNavClick(e, item.path)}
              aria-label={item.label}
              title={collapsed ? item.label : undefined}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current flex-shrink-0">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d={item.icon}></path>
              </svg>
              {#if !collapsed}
                <span class="truncate">{item.label}</span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>

      <div class="border-t border-base-300 p-2">
        <button
          class="btn btn-ghost btn-sm w-full {collapsed ? 'justify-center' : 'justify-start'}"
          onclick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current transition-transform {collapsed ? 'rotate-180' : ''}">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7"></path>
          </svg>
          {#if !collapsed}
            <span>Collapse</span>
          {/if}
        </button>
      </div>
    </aside>
  </div>
  <Toast />
</div>

<style>
  /* The sidebar width is driven by a CSS variable so the collapsed/expanded
     state can be toggled without fighting the drawer's grid layout (inline
     width on the grid item is unreliable). Only the variable changes at
     runtime; the rule itself is stable. */
  .tsir-sidebar {
    width: var(--tsir-sidebar-width, 16rem);
    max-width: var(--tsir-sidebar-width, 16rem);
  }
</style>
