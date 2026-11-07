<script lang="ts">
  let {
    open = false,
    title = 'Are you sure?',
    message = '',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    confirmClass = 'btn-error',
    onConfirm,
    onCancel,
  } = $props<{
    open?: boolean;
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    confirmClass?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }>();

  function handleConfirm() {
    onConfirm?.();
  }

  function handleCancel() {
    onCancel?.();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') handleCancel();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if open}
  <div class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <div class="modal-box">
      <h3 id="confirm-title" class="font-bold text-lg">{title}</h3>
      {#if message}
        <p class="py-4 text-sm text-base-content/70">{message}</p>
      {/if}
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={handleCancel}>{cancelText}</button>
        <button class={`btn ${confirmClass}`} onclick={handleConfirm}>{confirmText}</button>
      </div>
    </div>
    <label class="modal-backdrop" onclick={handleCancel}></label>
  </div>
{/if}
