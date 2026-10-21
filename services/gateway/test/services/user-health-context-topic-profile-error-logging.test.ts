/**
 * services/user-health-context.ts — user_topic_profile error-visibility fix.
 *
 * docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md Addendum 5 flags `user_topic_profile`
 * as the single highest-value unresolved finding: 5 call sites, only
 * spot-checked. This is one of them — `fetchUserTopicProfile()` queries a
 * table that does not exist in live Supabase, so every real call errors.
 * The read here was already wrapped as an explicitly-optional, non-fatal
 * source (comment: "the table may not exist in all environments — a
 * failed read is non-fatal"), which is correct design — but the failure
 * itself was completely invisible, discarding `topicsRes.error` and only
 * ever reading `topicsRes.data`.
 *
 * services/user-health-context.ts (400+ lines, 8 concurrent Supabase reads
 * behind a `safe()` wrapper) has no existing test harness to functionally
 * exercise this one branch through; per this codebase's established
 * pattern for modules impractical to fully mock (see the sibling
 * live-attendees-error-logging.test.ts / community-group-members-error-
 * logging.test.ts), this pins the fix at the source level: the branch now
 * logs the error via console.warn when present, while the non-fatal
 * fallback (topic_affinity simply stays empty) is byte-for-byte unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'user-health-context.ts');

describe('services/user-health-context.ts — fetchUserTopicProfile (topicsRes) error logging', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('checks topicsRes?.error before falling back to the non-fatal empty-affinity behavior', () => {
    const idx = src.indexOf('const topics = topicsRes?.data;');
    expect(idx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, idx - 300), idx);
    expect(before).toContain('if (topicsRes?.error)');
    expect(before).toContain('console.warn(');
  });

  it('the non-fatal fallback itself is unchanged: still reads topicsRes?.data and pushes the source only when topics is present', () => {
    const idx = src.indexOf('const topics = topicsRes?.data;');
    const after = src.slice(idx, idx + 400);
    expect(after).toContain('if (topics) {');
    expect(after).toContain("sources_queried.push('user_topic_profile');");
  });
});
