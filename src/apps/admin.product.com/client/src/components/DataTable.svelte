<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Column {
    key: string;
    label: string;
    className?: string;
    /** Optional custom renderer returning an HTML string. Use for badges, etc. */
    render?: (value: unknown, row: Record<string, unknown>) => string;
  }

  let {
    columns,
    rows,
    loading = false,
    page = 1,
    perPage = 20,
    total = 0,
    onPageChange,
    onRowClick,
    actions,
  } = $props<{
    columns: Column[];
    rows: Record<string, unknown>[];
    loading?: boolean;
    page?: number;
    perPage?: number;
    total?: number;
    onPageChange?: (page: number) => void;
    onRowClick?: (row: Record<string, unknown>) => void;
    actions?: Snippet<[Record<string, unknown>]>;
  }>();

  const totalPages = $derived(Math.max(1, Math.ceil(total / perPage)));
  const colCount = columns.length + (actions ? 1 : 0);

  function cellHtml(col: Column, row: Record<string, unknown>): string {
    if (col.render) return col.render(row[col.key], row);
    return String(row[col.key] ?? '');
  }
</script>

<div class="overflow-x-auto">
  <table class="table table-zebra">
    <thead>
      <tr>
        {#each columns as col}
          <th class={col.className}>{col.label}</th>
        {/each}
        {#if actions}
          <th class="text-right">Actions</th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#if loading}
        <tr>
          <td colspan={colCount} class="text-center py-8 text-base-content/50">
            <span class="loading loading-spinner loading-sm"></span>
          </td>
        </tr>
      {:else if rows.length === 0}
        <tr>
          <td colspan={colCount} class="text-center py-8 text-base-content/50">
            No records found.
          </td>
        </tr>
      {:else}
        {#each rows as r}
          <tr
            class={onRowClick ? 'cursor-pointer hover' : ''}
            onclick={onRowClick ? () => onRowClick(r) : undefined}
          >
            {#each columns as col}
              <td class={col.className}>{@html cellHtml(col, r)}</td>
            {/each}
            {#if actions}
              <td class="text-right" onclick={(e) => e.stopPropagation()}>
                {@render actions?.(r)}
              </td>
            {/if}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

{#if total > 0}
  <div class="flex justify-center items-center gap-4 mt-4">
    <button class="btn btn-sm" disabled={page <= 1} onclick={() => onPageChange?.(page - 1)}>← Prev</button>
    <span class="text-sm">Page {page} of {totalPages}</span>
    <button class="btn btn-sm" disabled={page >= totalPages} onclick={() => onPageChange?.(page + 1)}>Next →</button>
  </div>
{/if}
