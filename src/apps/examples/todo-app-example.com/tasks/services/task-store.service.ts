import { randomUUID } from 'node:crypto';

export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly order: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly status?: TaskStatus;
}

export interface UpdateTaskInput {
  readonly title?: string;
  readonly status?: TaskStatus;
  readonly order?: number;
}

/**
 * An in-memory task store. A real application would persist to a database;
 * the store's interface is what the controller depends on, so swapping the
 * implementation does not touch the HTTP layer.
 */
export class TaskStore {
  readonly #tasks = new Map<string, Task>();

  list(status?: TaskStatus): Task[] {
    const all = [...this.#tasks.values()].sort((a, b) => a.order - b.order);
    return status === undefined ? all : all.filter((task) => task.status === status);
  }

  get(id: string): Task | undefined {
    return this.#tasks.get(id);
  }

  create(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const status = input.status ?? 'todo';
    const order = this.nextOrder(status);
    const task: Task = {
      id: randomUUID(),
      title: input.title.trim(),
      status,
      order,
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.set(task.id, task);
    return task;
  }

  update(id: string, input: UpdateTaskInput): Task | undefined {
    const existing = this.#tasks.get(id);
    if (existing === undefined) return undefined;
    const updated: Task = {
      ...existing,
      title: input.title?.trim() ?? existing.title,
      status: input.status ?? existing.status,
      order: input.order ?? existing.order,
      updatedAt: new Date().toISOString(),
    };
    this.#tasks.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.#tasks.delete(id);
  }

  private nextOrder(status: TaskStatus): number {
    const sameStatus = this.list(status);
    return sameStatus.length === 0 ? 0 : sameStatus[sameStatus.length - 1].order + 1;
  }
}
