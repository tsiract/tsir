import { Controller, Get, Post, Put } from '@tsir/router';
import { registry } from '../routes.ts';

@Controller(registry, '/api/users')
export class UsersController {
  @Get('/', { tags: ['users'], operationId: 'users.list' })
  list(): unknown {
    return { page: 1, perPage: 20, data: [] };
  }

  @Post('/', { tags: ['users'], operationId: 'users.create' })
  create(): unknown {
    return { id: '00000000-0000-0000-0000-000000000000', email: 'new@example.com' };
  }

  @Get('/:id', { tags: ['users'], operationId: 'users.get' })
  get(params: { id: string }): unknown {
    return { id: params.id, email: 'user@example.com' };
  }

  @Put('/:id', { tags: ['users'], operationId: 'users.update' })
  update(params: { id: string }): unknown {
    return { id: params.id, email: 'updated@example.com' };
  }

  @Get('/:id/roles', { tags: ['users'], operationId: 'users.roles' })
  roles(params: { id: string }): unknown {
    return { id: params.id, roles: [] };
  }
}
