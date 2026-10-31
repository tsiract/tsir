// A WebSocket unit whose rooms live in a Durable Object. The class is exported from the
// entry because that is what the worker binding points at.

import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';

export const spec = defineConfig({});

export default defineApp({
  name: 'durable-app',
  config: spec,
  modules: [],
});

export const handler = (request: Request): Response =>
  new Response(`room: ${new URL(request.url).pathname}`);

/** The class `deploy.targets.cloudflare.bindings.ROOMS` names. */
export class Room {
  readonly state: unknown;
  constructor(state: unknown) {
    this.state = state;
  }
  fetch(request: Request): Response {
    return new Response(`room ${new URL(request.url).pathname}`);
  }
}
