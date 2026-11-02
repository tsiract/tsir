<script>
  let tasks = $state([]);
  let newTitle = $state('');
  let draggingId = $state(null);

  const COLUMNS = ['todo', 'doing', 'done'];

  async function load() {
    const res = await fetch('/api/tasks');
    const json = await res.json();
    tasks = json.data;
  }

  async function create(e) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    });
    newTitle = '';
    await load();
  }

  async function remove(id) {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    await load();
  }

  async function moveTo(id, status) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const sameStatus = tasks.filter((t) => t.status === status);
    const order = sameStatus.length;
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, order }),
    });
    await load();
  }

  function onDragStart(e, id) {
    draggingId = id;
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
  }

  function onDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  function onDrop(e, status) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    if (draggingId) moveTo(draggingId, status);
    draggingId = null;
  }

  function columnTasks(status) {
    return tasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.order - b.order);
  }

  load();
</script>

<h1>Todo Board</h1>

<form onsubmit={create}>
  <input
    bind:value={newTitle}
    placeholder="Add a task…"
    autocomplete="off"
  />
  <button type="submit">Add</button>
</form>

<div class="board">
  {#each COLUMNS as status}
    <div
      class="column"
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={(e) => onDrop(e, status)}
    >
      <h2>{status}</h2>
      {#each columnTasks(status) as task (task.id)}
        <div
          class="task"
          class:dragging={draggingId === task.id}
          draggable="true"
          ondragstart={(e) => onDragStart(e, task.id)}
        >
          <button class="delete" onclick={() => remove(task.id)}>×</button>
          {task.title}
        </div>
      {/each}
    </div>
  {/each}
</div>
