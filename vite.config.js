import { defineConfig } from 'vite';

export default defineConfig({
  // The account API (server/) runs on 5070 (not 5060: browsers block that port); the game calls it at /api
  server: { proxy: { '/api': 'http://localhost:5070' } },
  preview: { proxy: { '/api': 'http://localhost:5070' } },
  build: {
    chunkSizeWarningLimit: 900, // three.js alone is ~545 kB minified; that's expected
  },
});
