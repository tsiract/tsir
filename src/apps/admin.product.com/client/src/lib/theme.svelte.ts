/**
 * Reactive theme store for the admin SPA.
 *
 * Tracks the active DaisyUI theme (`abyss` or `silk`) and persists the choice
 * to `localStorage` under `tsir-admin-theme`. The initial value is read from
 * the DOM attribute set by the pre-paint script in `public/index.html`, so
 * there is never a flash of the wrong theme.
 */
export type AdminTheme = 'abyss' | 'silk';

const STORAGE_KEY = 'tsir-admin-theme';

function readInitial(): AdminTheme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'abyss' || attr === 'silk') return attr;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'abyss' : 'silk';
}

// Exported state is a container object; we mutate `.value` rather than
// reassigning the export, which is the only pattern Svelte 5 allows for
// shared $state across module boundaries.
export const theme = $state({ value: readInitial() });

export function setTheme(next: AdminTheme): void {
  theme.value = next;
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage may be unavailable (private mode); non-fatal */
  }
}

export function toggleTheme(): void {
  setTheme(theme.value === 'abyss' ? 'silk' : 'abyss');
}

/** Read in reactive contexts (templates, $derived, $effect) to stay live. */
export function isDark(): boolean {
  return theme.value === 'abyss';
}
