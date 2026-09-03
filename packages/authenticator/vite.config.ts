import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Authenticator runs on its own port, which makes it a genuinely separate
 * origin from the console: separate localStorage, separate key vault, separate
 * everything. That separation is the security property, not a deployment
 * detail -- compromising the console gets you no closer to the key.
 */
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
