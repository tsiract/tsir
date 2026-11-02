import { describe, expect, test } from 'bun:test';

import { compileRoutes, type ControllerEntry } from '@tsir/router';

import app, { handler } from '../app.ts';
import { tasks } from '../tasks/index.ts';

const appEntries = (): readonly ControllerEntry[] => [...tasks.registry.entries()];

const get = (path: string, init?: RequestInit): Promise<Response> =>
  handler(new Request(`http://tsir.test${path}`, init));

describe('todo example', () => {
  test('boots through the same path production uses', async () => {
    const instance = await app.createApp({ mode: 'test', env: { APP_ENV: 'test' } });
    expect(instance.state.kind).toBe('ready');
    await instance.shutdown('manual');
  });

  test('the registry compiles into a table with the declared routes', () => {
    const table = compileRoutes(appEntries());
    expect(table.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/tasks/:id',
      'GET /',
      'GET /api/tasks',
      'GET /api/tasks/:id',
      'GET /app.js',
      'PATCH /api/tasks/:id',
      'POST /api/tasks',
    ]);
  });

  test('serves the frontend HTML at /', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('Todo — Tsir + Svelte 5');
  });

  test('creates a task and lists it', async () => {
    const created = await get('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Write tests' }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; title: string; status: string };
    expect(task.title).toBe('Write tests');
    expect(task.status).toBe('todo');

    const list = await get('/api/tasks');
    const json = (await list.json()) as { data: { title: string }[] };
    expect(json.data.some((t) => t.title === 'Write tests')).toBe(true);
  });

  test('validates the task title', async () => {
    const rejected = await get('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(rejected.status).toBe(422);
  });

  test('updates a task status and order', async () => {
    const created = await get('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drag me' }),
    });
    const task = (await created.json()) as { id: string };

    const updated = await get(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'doing', order: 0 }),
    });
    expect(updated.status).toBe(200);
    const json = (await updated.json()) as { status: string; order: number };
    expect(json.status).toBe('doing');
    expect(json.order).toBe(0);
  });

  test('deletes a task', async () => {
    const created = await get('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Delete me' }),
    });
    const task = (await created.json()) as { id: string };

    const removed = await get(`/api/tasks/${task.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });
});
