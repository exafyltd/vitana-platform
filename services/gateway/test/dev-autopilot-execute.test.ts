/**
 * Tests for Developer Autopilot execute helpers.
 *
 * Full approve/cancel flows require Supabase; covered by integration tests.
 * Unit tests here lock the deletion-intent parser used by the safety gate.
 */

import { extractDeletions } from '../src/services/dev-autopilot-execute';

describe('extractDeletions', () => {
  it('detects "delete" keyword followed by a path', () => {
    const md = '- delete services/gateway/src/services/dead.ts';
    expect(extractDeletions(md)).toContain('services/gateway/src/services/dead.ts');
  });

  it('detects "remove" and "drop" keywords too', () => {
    const md = [
      '- remove services/gateway/src/routes/unused.ts',
      '- drop services/agents/legacy/thing.ts',
    ].join('\n');
    const paths = extractDeletions(md);
    expect(paths).toContain('services/gateway/src/routes/unused.ts');
    expect(paths).toContain('services/agents/legacy/thing.ts');
  });

  it('works with backtick-quoted paths', () => {
    const md = 'delete `services/gateway/src/services/old.ts`';
    expect(extractDeletions(md)).toContain('services/gateway/src/services/old.ts');
  });

  it('returns empty for plans without deletion intent', () => {
    const md = '- modify services/gateway/src/routes/auth.ts';
    expect(extractDeletions(md)).toEqual([]);
  });

  it('deduplicates repeated deletions', () => {
    const md = [
      '- delete services/gateway/src/services/foo.ts',
      'We will delete services/gateway/src/services/foo.ts in step 2.',
    ].join('\n');
    expect(extractDeletions(md)).toEqual(['services/gateway/src/services/foo.ts']);
  });
});
