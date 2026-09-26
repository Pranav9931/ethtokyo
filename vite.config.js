import { defineConfig } from 'vite';

const backend = 'http://localhost:8787';
export default defineConfig({
  optimizeDeps: { exclude: ['@worldcoin/idkit-core'] }, // loads its own WASM via import.meta.url
  server: {
    port: 5173,
    proxy: {
      '/api': backend, '/auth': backend, '/mock-world': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
    },
  },
});
