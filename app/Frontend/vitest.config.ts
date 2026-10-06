import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Client test infrastructure (docs/BOT_IMPLEMENTATION_PLAN.md §23.3, Option A).
 *
 * Vitest + Testing Library over jsdom, with the same `@/` alias the app uses so tests import
 * modules the way the components do. The feature's highest-risk client logic — dirty
 * detection, the 409 merge, draft-preserving error handling and preview isolation — is pure
 * logic that is cheap to test and expensive to regress.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});