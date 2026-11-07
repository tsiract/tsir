<script lang="ts">
  let { title = 'Something went wrong', message = '', onRetry } = $props<{
    title?: string;
    message?: string;
    onRetry?: () => void;
  }>();
</script>

<div class="flex flex-col items-center justify-center py-12 text-center">
  <div class="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mb-4">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-8 h-8 stroke-error">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
    </svg>
  </div>
  <h3 class="text-lg font-semibold">{title}</h3>
  {#if message}
    <p class="text-sm text-base-content/60 mt-1 max-w-md">{message}</p>
  {/if}
  {#if onRetry}
    <button class="btn btn-ghost btn-sm mt-4" onclick={onRetry}>Try again</button>
  {/if}
</div>
