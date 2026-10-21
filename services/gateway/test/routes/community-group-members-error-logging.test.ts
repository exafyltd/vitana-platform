/**
 * routes/community.ts — community_group_members error-visibility fix.
 *
 * community_group_members does not exist in live Supabase (confirmed via
 * AURORA-B2-DEAD-CALLSITE-AUDIT.md's Addendum 7), so the one call site to
 * repo.fetchGroupMembersExcluding() always fails today — silently,
 * previously, since only `data` was destructured and the `(x || [])`
 * fallback swallowed the failure indistinguishably from "no other
 * members." Net effect in production: the "someone new joined your group"
 * notification to existing members never fires for any group, ever, with
 * nothing in logs.
 *
 * routes/community.ts has no existing test harness to route-test this
 * fire-and-forget notification block through (auth/JWT parsing, live
 * Supabase client construction inside the handler); per this codebase's
 * established pattern for large/stateful modules impractical to fully
 * mock (see the sibling live-attendees-error-logging.test.ts and
 * admin-users-error-logging.test.ts), this pins the fix at the source
 * level instead: the call site now destructures `error` and logs it via
 * console.error, while the empty-array fallback (and the underlying
 * missing-table product decision) stays byte-for-byte unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'community.ts');

describe('routes/community.ts — fetchGroupMembersExcluding error logging', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const callSites = src.split('fetchGroupMembersExcluding(supa,').slice(1);

  it('has exactly one call site (notify-other-group-members-on-join)', () => {
    expect(callSites.length).toBe(1);
  });

  it('destructures `error` from the call, not just `data`', () => {
    const matches = [...src.matchAll(/const \{ data: (\w+), error: (\w+) \} = await repo\.fetchGroupMembersExcluding\(/g)];
    expect(matches.length).toBe(1);
  });

  it('logs the error via console.error when present, before falling back to an empty array', () => {
    const [, dataVar, errVar] = [...src.matchAll(/const \{ data: (\w+), error: (\w+) \} = await repo\.fetchGroupMembersExcluding\(/g)][0];
    const idx = src.indexOf(`error: ${errVar} } = await repo.fetchGroupMembersExcluding(`);
    const after = src.slice(idx, idx + 400);
    expect(after).toMatch(new RegExp(`if \\(${errVar}\\) \\{`));
    expect(after).toContain('console.error(');
    // The fallback that swallows a missing/errored result must be
    // byte-for-byte unchanged: still `(x || []).map(...)`.
    expect(after).toContain(`(${dataVar} || [])`);
  });
});
