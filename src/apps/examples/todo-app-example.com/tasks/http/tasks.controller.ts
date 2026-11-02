import { Controller, Delete, Get, Patch, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { UuidParam } from '@tsir/validate/http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { registry } from '../routes.ts';
import { TaskStore, type TaskStatus } from '../services/task-store.service.ts';

const store = new TaskStore();
const PUBLIC_DIR = join(dirname(import.meta.dir), 'public');

export const CreateTask = z.object({
  title: z.string().min(1).max(200),
  status: z.enum(['todo', 'doing', 'done']).optional(),
});

export const UpdateTask = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  order: z.number().int().min(0).optional(),
});

export const TaskIdParams = z.object({ id: UuidParam });

@Controller(registry, '/api/tasks')
export class TasksController {
  @Get('/', { tags: ['tasks'], operationId: 'tasks.list' })
  list(): unknown {
    return { data: store.list() };
  }

  @Get('/:id', { params: TaskIdParams, tags: ['tasks'] })
  findOne({ params }: { params: { id: string } }): unknown {
    const task = store.get(params.id);
    if (task === undefined) {
      return new Response(null, { status: 404 });
    }
    return task;
  }

  @Post('/', { body: CreateTask, status: 201, tags: ['tasks'] })
  create({ body }: { body: z.infer<typeof CreateTask> }): unknown {
    return store.create(body);
  }

  @Patch('/:id', { params: TaskIdParams, body: UpdateTask, tags: ['tasks'] })
  update({
    params,
    body,
  }: {
    params: { id: string };
    body: z.infer<typeof UpdateTask>;
  }): unknown {
    const task = store.update(params.id, body);
    if (task === undefined) {
      return new Response(null, { status: 404 });
    }
    return task;
  }

  @Delete('/:id', { params: TaskIdParams, status: 204, tags: ['tasks'] })
  remove({ params }: { params: { id: string } }): void {
    store.remove(params.id);
  }
}

/**
 * Serves the Svelte 5 drag-and-drop frontend. The compiled app.js is emitted
 * by `bun run build:client.ts` and served from the same directory as this
 * controller's source.
 */
@Controller(registry, '/')
export class FrontendController {
  @Get('/', { tags: ['frontend'] })
  index(): Response {
    return new Response(HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  @Get('/app.js', { tags: ['frontend'] })
  appScript(): Response {
    const js = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8');
    return new Response(js, {
      headers: { 'content-type': 'application/javascript; charset=utf-8' },
    });
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Todo — Tsir + Svelte 5</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 2rem;
    }
    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; color: #f1f5f9; }
    .board {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      max-width: 900px;
    }
    .column {
      background: #1e293b;
      border-radius: 12px;
      padding: 1rem;
      min-height: 300px;
    }
    .column h2 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      margin-bottom: 0.75rem;
    }
    .task {
      background: #334155;
      border-radius: 8px;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      cursor: grab;
      transition: transform 0.1s, box-shadow 0.1s;
    }
    .task:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .task:active { cursor: grabbing; }
    .task.dragging { opacity: 0.5; }
    .column.drag-over { outline: 2px dashed #38bdf8; }
    form { margin-bottom: 1.5rem; display: flex; gap: 0.5rem; max-width: 900px; }
    input {
      flex: 1;
      padding: 0.6rem 0.8rem;
      border-radius: 8px;
      border: 1px solid #334155;
      background: #1e293b;
      color: #e2e8f0;
      font-size: 0.9rem;
    }
    button {
      padding: 0.6rem 1.2rem;
      border-radius: 8px;
      border: none;
      background: #38bdf8;
      color: #0f172a;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #7dd3fc; }
    .delete {
      background: none;
      color: #f87171;
      padding: 0.2rem 0.5rem;
      font-size: 0.75rem;
      float: right;
    }
    .delete:hover { background: rgba(248,113,113,0.1); }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
