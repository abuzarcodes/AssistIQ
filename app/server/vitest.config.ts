import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    // The source uses NodeNext `.js` import specifiers that point at `.ts` files.
    // Teach Vite/Vitest to resolve `./foo.js` -> `./foo.ts` so those imports load.
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
