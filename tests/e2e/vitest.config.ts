import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'e2e',
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 60000,
  },
});
