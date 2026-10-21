/**
 * services/social-connect-service.ts — user_topic_profile error-visibility fix.
 *
 * docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md Addendum 5 flags `user_topic_profile`
 * as the single highest-value unresolved finding: 5 call sites, only
 * spot-checked. This is one of them — `upsertUserTopicProfile()` writes to
 * a table that does not exist in live Supabase, so every real call errors.
 * The write's result was previously discarded entirely (not even
 * destructured), and the code unconditionally recorded
 * `enrichments.push('topics:...')` regardless of whether the write
 * actually landed — a false "success" signal in the enrichment audit
 * trail, with the underlying failure completely invisible.
 *
 * services/social-connect-service.ts (1000+ lines: OAuth flows, external
 * provider API calls, media extraction) has no existing test harness to
 * functionally exercise this one branch through; per this codebase's
 * established pattern for modules impractical to fully mock, this pins
 * the fix at the source level: the write's error is now captured and
 * logged via console.warn per topic, while the enrichments-list behavior
 * itself (a separate, more invasive judgment call) is left unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'social-connect-service.ts');

describe('services/social-connect-service.ts — upsertUserTopicProfile error logging', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('destructures `error` from the upsert call, not discarding the result entirely', () => {
    const match = src.match(/const \{ error: (\w+) \} = await repo\.upsertUserTopicProfile\(/);
    expect(match).not.toBeNull();
  });

  it('logs the error via console.warn per topic when present, before the (unchanged) enrichments bookkeeping', () => {
    const match = src.match(/const \{ error: (\w+) \} = await repo\.upsertUserTopicProfile\(/);
    const errVar = match![1];
    const idx = src.indexOf(`const { error: ${errVar} } = await repo.upsertUserTopicProfile(`);
    const after = src.slice(idx, idx + 500);
    expect(after).toMatch(new RegExp(`if \\(${errVar}\\) \\{`));
    expect(after).toContain('console.warn(');
  });

  it('the enrichments bookkeeping after the loop is unchanged (a separate, not-touched judgment call)', () => {
    const idx = src.indexOf("enrichments.push(`topics:");
    expect(idx).toBeGreaterThan(-1);
  });
});
