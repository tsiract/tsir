<script lang="ts">
  import { toasts, dismissToast, type ToastKind } from '../lib/toast.svelte.ts';

  const kindClass: Record<ToastKind, string> = {
    success: 'alert-success',
    error: 'alert-error',
    info: 'alert-info',
  };

  const kindIcon: Record<ToastKind, string> = {
    success: 'M5 13l4 4L19 7',
    error: 'M6 18L18 6M6 6l12 12',
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  };
</script>

<div class="toast toast-end toast-top z-50">
  {#each toasts.items as t (t.id)}
    <div class={`alert ${kindClass[t.kind]} shadow-lg`} role="alert">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-5 h-5 stroke-current flex-shrink-0">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={kindIcon[t.kind]}></path>
      </svg>
      <span class="text-sm">{t.message}</span>
      <button class="ml-2 opacity-60 hover:opacity-100" onclick={() => dismissToast(t.id)} aria-label="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-4 h-4 stroke-current">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>
    </div>
  {/each}
</div>
