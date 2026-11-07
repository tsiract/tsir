/**
 * Admin SPA entry point.
 *
 * Mounts the Svelte 5 app into the `#app` root. The root element lives in
 * `public/index.html`.
 */
import { mount } from 'svelte';
import App from './App.svelte';

const root = document.getElementById('app');
if (root === null) {
  throw new Error('missing #app root element — index.html must define <div id="app"></div>');
}

mount(App, { target: root });
