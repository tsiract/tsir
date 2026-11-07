import { Controller, Post } from '@tsir/router';
import { z } from '@tsir/validate';
import { registry } from '../routes.ts';

const Upload = z.object({
  name: z.string().min(1),
  mime: z.string().min(1),
});

@Controller(registry, '/api')
export class MediaController {
  @Post('/uploads', { tags: ['media'], operationId: 'media.upload' })
  upload(body: unknown): unknown {
    const parsed = Upload.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          code: 'HTP_VALIDATION_FAILED',
          errors: parsed.error.issues,
        }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return { ok: true };
  }
}
