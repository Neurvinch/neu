import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // PostCSS otherwise walks up past the repo root and picks up unrelated
  // configs from the drive above it. This project uses plain CSS; pin it here.
  css: { postcss: { plugins: [] } },
  server: {
    port: 5173,
    proxy: {
      // Includes /api/events: http-proxy streams SSE through untouched, which
      // is what keeps every screen's countdown live.
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
