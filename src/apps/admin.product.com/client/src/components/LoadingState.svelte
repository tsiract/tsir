<script lang="ts">
  let { label = 'Loading…' } = $props<{ label?: string }>();
</script>

<div class="flex items-center gap-3 py-12 justify-center text-base-content/60">
  <span class="loading loading-spinner loading-md"></span>
  <span>{label}</span>
</div>
