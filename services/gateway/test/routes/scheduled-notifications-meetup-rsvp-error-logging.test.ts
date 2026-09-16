/**
 * routes/scheduled-notifications.ts — community_meetup_attendance error-
 * visibility fix (docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md Addendum 9, the
 * "left unfixed" meetup-RSVP-reminder gap).
 *
 * `repo.fetchMeetupRsvps()` queries `community_meetup_attendance`, which
 * does not exist in live Supabase, so every real call to it errors. Both
 * call sites here (meetup_starting_soon, meetup_starting_now) previously
 * destructured only `{ data: rsvps }`, discarding the error — meaning
 * nobody who RSVP'd to a community meetup has ever received a "starting
 * soon"/"starting now" reminder, with the cron reporting success every
 * time and nothing in logs marking it as a failure.
 *
 * routes/scheduled-notifications.ts (1000+ lines, many cron endpoints) has
 * no existing test harness to route-test this specific fire-and-forget
 * notification loop through cheaply; per this codebase's established
 * pattern for large/stateful modules impractical to fully mock (see the
 * sibling live-attendees-error-logging.test.ts / community-group-members-
 * error-logging.test.ts), this pins the fix at the source level instead:
 * both call sites now destructure `error` and log it via console.warn,
 * while the empty-array fallback (and the underlying missing-table
 * product decision) stays byte-for-byte unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'scheduled-notifications.ts');

describe('routes/scheduled-notifications.ts — fetchMeetupRsvps error logging', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const callSites = src.split('fetchMeetupRsvps(supa,').slice(1);

  it('has exactly the two known call sites (meetup_starting_soon + meetup_starting_now)', () => {
    expect(callSites.length).toBe(2);
  });

  it('every call site destructures `error` from the call, not just `data`', () => {
    const matches = [...src.matchAll(/const \{ data: (\w+), error: (\w+) \} = await repo\.fetchMeetupRsvps\(/g)];
    expect(matches.length).toBe(2);
  });

  it('every call site logs the error via console.warn when present, before falling back to an empty array', () => {
    for (const [, dataVar, errVar] of [...src.matchAll(/const \{ data: (\w+), error: (\w+) \} = await repo\.fetchMeetupRsvps\(/g)]) {
      const idx = src.indexOf(`error: ${errVar} } = await repo.fetchMeetupRsvps(`);
      const after = src.slice(idx, idx + 300);
      expect(after).toMatch(new RegExp(`if \\(${errVar}\\) \\{`));
      expect(after).toContain('console.warn(');
      // The fallback that swallows a missing/errored result must be
      // byte-for-byte unchanged: still `(x || [])`.
      expect(after).toContain(`(${dataVar} || [])`);
    }
  });
});
