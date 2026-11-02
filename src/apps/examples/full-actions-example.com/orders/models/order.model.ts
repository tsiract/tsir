export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled';

export interface Order {
  readonly id: string;
  readonly customerEmail: string;
  readonly amount: number;
  readonly status: OrderStatus;
  readonly createdAt: string;
}

export interface CreateOrderInput {
  readonly customerEmail: string;
  readonly amount: number;
}
