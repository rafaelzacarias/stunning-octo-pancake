import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: {
    format: 'es'
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat']
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 3000
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
});
