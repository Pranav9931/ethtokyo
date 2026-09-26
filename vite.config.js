import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const backend = 'http://localhost:8787';
export default defineConfig({
  build: { rollupOptions: { input: { home: resolve(process.cwd(), 'index.html'), console: resolve(process.cwd(), 'console.html'), controller: resolve(process.cwd(), 'controller.html') } } },
  optimizeDeps: { exclude: ['@worldcoin/idkit-core'] }, // loads its own WASM via import.meta.url
  server: {
    port: 5173,
    proxy: {
      '/api': backend, '/auth': backend, '/mock-world': backend, '/scenes': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
    },
  },
});
