import { randomUUID } from 'node:crypto';

import type { CreateOrderInput, Order, OrderStatus } from '../models/order.model.ts';

/**
 * In-memory order store. A real application would persist to a database and
 * dispatch events inside the same transaction (the outbox pattern). The
 * service interface is what the controller depends on.
 */
export class OrderService {
  readonly #orders = new Map<string, Order>();

  list(): Order[] {
    return [...this.#orders.values()];
  }

  get(id: string): Order | undefined {
    return this.#orders.get(id);
  }

  create(input: CreateOrderInput): Order {
    const order: Order = {
      id: randomUUID(),
      customerEmail: input.customerEmail,
      amount: input.amount,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.#orders.set(order.id, order);
    return order;
  }

  updateStatus(id: string, status: OrderStatus): Order | undefined {
    const existing = this.#orders.get(id);
    if (existing === undefined) return undefined;
    const updated: Order = { ...existing, status };
    this.#orders.set(id, updated);
    return updated;
  }
}
