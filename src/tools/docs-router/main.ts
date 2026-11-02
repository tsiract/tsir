/**
 * Mounts the docs client-side router.
 *
 * The router itself has no visible DOM; it only wires up click handlers for
 * internal navigation. Mounting it at document.body is harmless.
 */
import { mount } from 'svelte';
import DocsRouter from './router.svelte';

// This file is bundled by esbuild for the browser; the main tsconfig has no
// DOM lib, so we access `document` through a minimal structural type.
const doc = (globalThis as { document?: { body: unknown } }).document;
if (doc?.body) mount(DocsRouter, { target: doc.body });
