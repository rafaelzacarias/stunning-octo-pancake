import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build works from a user site, a project site
  // (https://<user>.github.io/<repo>/) or a plain file server without rebuilding.
  base: './',
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  // NOTE: no COOP/COEP headers here on purpose. They would make dev
  // cross-origin isolated while production is not, and GitHub Pages cannot set
  // response headers at all. The physics worker uses transferable
  // ArrayBuffers (not SharedArrayBuffer) and Rapier's wasm is inlined, so
  // nothing needs cross-origin isolation.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
