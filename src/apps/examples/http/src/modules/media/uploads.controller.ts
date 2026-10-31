/**
 * A file-upload controller, deliberately attributed to its own deploy unit.
 *
 * Two Phase 2 features meet here:
 *
 *   · **VLD-006** — `multipart/form-data` with per-route limits and sniffed
 *     MIME types. The bounds live on the route (`multipart: {...}`) because they
 *     are enforced while parsing, before any validator runs.
 *   · **RTR-011 / MOD-002** — the module declares `unit: 'media'`, so these
 *     routes belong to a separate deployable without the controller repeating
 *     it. Nothing at request time reads it; `tsir route:list` prints it, and the
 *     deploy planner groups by it.
 */

import { Controller, Post } from '@tsir/router';

import { z } from '@tsir/validate';
import { FileField } from '@tsir/validate/http';

import { registry } from './routes.ts';

export const UploadBody = z.object({
  caption: z.string().max(200).optional(),
  image: FileField({ mimeTypes: ['image/png', 'image/jpeg'], maxBytes: 256 * 1024 }),
});

@Controller(registry, '/api/uploads')
export class UploadsController {
  @Post('/', {
    consumes: ['multipart/form-data'],
    body: UploadBody,
    multipart: { maxFileBytes: 256 * 1024, maxFiles: 1 },
    status: 201,
    tags: ['uploads'],
    operationId: 'uploads.create',
  })
  create({ body }: { body: z.infer<typeof UploadBody> }): unknown {
    return {
      caption: body.caption ?? null,
      image: { name: body.image.name, size: body.image.size, type: body.image.type },
    };
  }
}
