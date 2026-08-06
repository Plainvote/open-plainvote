import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // See voter-ui: one shared brand-asset directory in the theme package.
  publicDir: '../../packages/theme/public',
  server: {
    port: 5175,
    strictPort: true,
  },
});
