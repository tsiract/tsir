<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, subtitle, actions } = $props<{
    title: string;
    subtitle?: string;
    actions?: Snippet;
  }>();
</script>

<div class="flex items-center justify-between flex-wrap gap-3">
  <div>
    <h1 class="text-2xl font-bold">{title}</h1>
    {#if subtitle}
      <p class="text-sm text-base-content/60 mt-0.5">{subtitle}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex items-center gap-2">
      {@render actions()}
    </div>
  {/if}
</div>
