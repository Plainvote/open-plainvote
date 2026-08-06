import { defineConfig } from 'vitest/config';

/*
 * Node environment, deliberately: everything under test here is pure. The
 * React hooks in this package are verified in a browser against the running
 * apps, which is also the only place their real behaviour (hashchange, focus)
 * is worth asserting. Testing them here would mean adding jsdom and a
 * component-testing library for coverage a real browser already gives.
 */
export default defineConfig({
  test: {
    name: 'ui',
    environment: 'node',
  },
});
