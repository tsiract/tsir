<script lang="ts">
  let { title = 'Nothing here yet', message = '' } = $props<{ title?: string; message?: string }>();
</script>

<div class="flex flex-col items-center justify-center py-16 text-center">
  <div class="w-16 h-16 rounded-full bg-base-200 flex items-center justify-center mb-4">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-8 h-8 stroke-base-content/40">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
    </svg>
  </div>
  <h3 class="text-lg font-semibold">{title}</h3>
  {#if message}
    <p class="text-sm text-base-content/60 mt-1 max-w-md">{message}</p>
  {/if}
</div>
