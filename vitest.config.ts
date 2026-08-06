import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Globs, not a list: the public open-plainvote export carries a subset of
    // packages, and the same config must work in both repos.
    projects: ['packages/*/vitest.config.ts', 'tests/e2e/vitest.config.ts'],
    passWithNoTests: true,
  },
});
