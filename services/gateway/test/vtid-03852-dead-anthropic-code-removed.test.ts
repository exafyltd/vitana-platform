/**
 * VTID-03852: dev-autopilot-execute.ts carried module-level
 * ANTHROPIC_API_KEY/ANTHROPIC_BASE constants that were never read anywhere
 * in the file after VTID-02686 rewired the real call to
 * callViaRouter('worker', ...) — misleading dead code implying a direct
 * Anthropic API path that (per CLAUDE.md §1b: that key is never populated in
 * AWS Secrets Manager) could not have worked anyway. callMessagesApi() was
 * also renamed to callRoutedLlm to stop implying the same thing.
 *
 * Source-level regression guard — this module isn't unit-testable in
 * isolation (needs a live Supabase connection), matching the established
 * pattern for its sibling VTID-0382x tests.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE: string = fs.readFileSync(
  path.join(__dirname, '../src/services/dev-autopilot-execute.ts'),
  'utf8'
);

describe('dev-autopilot-execute.ts dead Anthropic-direct code removed (VTID-03852)', () => {
  it('no longer declares ANTHROPIC_API_KEY/ANTHROPIC_BASE as module-level constants', () => {
    expect(SOURCE).not.toMatch(/^const ANTHROPIC_API_KEY/m);
    expect(SOURCE).not.toMatch(/^const ANTHROPIC_BASE/m);
  });

  it('callMessagesApi was renamed to callRoutedLlm', () => {
    expect(SOURCE).toContain('async function callRoutedLlm(');
    expect(SOURCE).not.toMatch(/function callMessagesApi\(/);
  });

  it('callRoutedLlm still dispatches through callViaRouter, not a raw fetch to api.anthropic.com', () => {
    const start = SOURCE.indexOf('async function callRoutedLlm(');
    const end = SOURCE.indexOf('\n}', start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain("callViaRouter('worker', prompt,");
    expect(body).not.toContain('api.anthropic.com');
  });
});
