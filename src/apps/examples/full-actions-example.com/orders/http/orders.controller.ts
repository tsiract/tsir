import { Controller, Get, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { UuidParam } from '@tsir/validate/http';

import { registry } from '../routes.ts';
import { OrderService } from '../services/order.service.ts';

const orders = new OrderService();

export const CreateOrder = z.object({
  customerEmail: z.email(),
  amount: z.number().positive(),
});

export const OrderIdParams = z.object({ id: UuidParam });

@Controller(registry, '/api/orders')
export class OrdersController {
  @Get('/', { tags: ['orders'], operationId: 'orders.list' })
  list(): unknown {
    return { data: orders.list() };
  }

  @Get('/:id', { params: OrderIdParams, tags: ['orders'] })
  findOne({ params }: { params: { id: string } }): unknown {
    const order = orders.get(params.id);
    if (order === undefined) {
      return new Response(null, { status: 404 });
    }
    return order;
  }

  @Post('/', { body: CreateOrder, status: 201, tags: ['orders'] })
  create({ body }: { body: z.infer<typeof CreateOrder> }): unknown {
    return orders.create(body);
  }
}
