import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * Checkpoint 8 — the design-token guard, asserted over the whole tree (plan §18.5, §23.3).
 *
 * The scanner is also wired into `npm run lint`; this test makes the same claim inside the
 * suite, so a regression fails a test as well as a lint run. A deliberate literal anywhere
 * outside the documented allow-list exits non-zero, which is the property under test.
 */
describe('design-token scanner', () => {
  it('reports no new hard-coded colours', () => {
    const output = execFileSync('node', ['scripts/check-design-tokens.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(output).toContain('Design-token check passed');
  });
});