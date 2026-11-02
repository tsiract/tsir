import 'svelte/internal/disclose-version';
import * as $ from 'svelte/internal/client';

var root = $.from_html(`<div draggable="true"><button class="delete">×</button> </div>`);
var root_1 = $.from_html(`<div class="column"><h2> </h2> <!></div>`);
var root_2 = $.from_html(`<h1>Todo Board</h1> <form><input placeholder="Add a task…" autocomplete="off"/> <button type="submit">Add</button></form> <div class="board"></div>`, 1);

export default function App($$anchor, $$props) {
	$.push($$props, true);

	let tasks = $.state($.proxy([]));
	let newTitle = $.state('');
	let draggingId = $.state(null);
	const COLUMNS = ['todo', 'doing', 'done'];

	async function load() {
		const res = await fetch('/api/tasks');
		const json = await res.json();

		$.set(tasks, json.data, true);
	}

	async function create(e) {
		e.preventDefault();

		if (!$.get(newTitle).trim()) return;

		await fetch('/api/tasks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: $.get(newTitle) })
		});

		$.set(newTitle, '');
		await load();
	}

	async function remove(id) {
		await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
		await load();
	}

	async function moveTo(id, status) {
		const task = $.get(tasks).find((t) => t.id === id);

		if (!task) return;

		const sameStatus = $.get(tasks).filter((t) => t.status === status);
		const order = sameStatus.length;

		await fetch(`/api/tasks/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ status, order })
		});

		await load();
	}

	function onDragStart(e, id) {
		$.set(draggingId, id, true);
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

		if ($.get(draggingId)) moveTo($.get(draggingId), status);

		$.set(draggingId, null);
	}

	function columnTasks(status) {
		return $.get(tasks).filter((t) => t.status === status).sort((a, b) => a.order - b.order);
	}

	load();

	var fragment = root_2();
	var form = $.sibling($.first_child(fragment), 2);
	var input = $.child(form);

	$.remove_input_defaults(input);
	$.next(2);
	$.reset(form);

	var div = $.sibling(form, 2);

	$.each(div, 21, () => COLUMNS, $.index, ($$anchor, status) => {
		var div_1 = root_1();
		var h2 = $.child(div_1);
		var text = $.only_child(h2, true);
		var node = $.sibling(h2, 2);

		$.each(node, 17, () => columnTasks($.get(status)), (task) => task.id, ($$anchor, task) => {
			var div_2 = root();
			let classes;
			var button = $.child(div_2);
			var text_1 = $.sibling(button);

			$.reset(div_2);

			$.template_effect(() => {
				classes = $.set_class(div_2, 1, 'task', null, classes, { dragging: $.get(draggingId) === $.get(task).id });
				$.set_text(text_1, ` ${$.get(task).title ?? ''}`);
			});

			$.event('dragstart', div_2, (e) => onDragStart(e, $.get(task).id));
			$.delegated('click', button, () => remove($.get(task).id));
			$.append($$anchor, div_2);
		});

		$.reset(div_1);
		$.template_effect(() => $.set_text(text, $.get(status)));
		$.event('dragover', div_1, onDragOver);
		$.event('dragleave', div_1, onDragLeave);
		$.event('drop', div_1, (e) => onDrop(e, $.get(status)));
		$.append($$anchor, div_1);
	});

	$.reset(div);
	$.event('submit', form, create);
	$.bind_value(input, () => $.get(newTitle), ($$value) => $.set(newTitle, $$value));
	$.append($$anchor, fragment);
	$.pop();
}

$.delegate(['click']);