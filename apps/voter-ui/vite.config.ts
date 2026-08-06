import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Brand assets (the favicon) live once in the theme package and are served
  // at / by every app, rather than copied into four public/ directories that
  // would drift apart. Anything added there ships in all four bundles.
  publicDir: '../../packages/theme/public',
  server: {
    port: 5173,
    strictPort: true,
  },
});
