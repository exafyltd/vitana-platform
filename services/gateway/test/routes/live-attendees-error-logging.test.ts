/**
 * routes/live.ts — live_room_attendees error-visibility fix.
 *
 * live_room_attendees does not exist in live Supabase (confirmed via
 * AURORA-B2-DEAD-CALLSITE-AUDIT.md's Addendum 9), so both call sites to
 * repo.fetchLiveRoomAttendeesExcluding() always fail today — silently,
 * previously, since only `data` was destructured and the `(x || [])`
 * fallback swallowed the failure indistinguishably from "no attendees."
 *
 * routes/live.ts (2300+ lines: LiveKit session management, JWT parsing,
 * real-time room state) has no existing test harness to route-test these
 * two notification side-effect blocks through; per this codebase's
 * established pattern for large/stateful modules impractical to fully
 * mock (see orb-live.ts's own characterization tests), this pins the fix
 * at the source level instead: both call sites now destructure `error`
 * and log it via console.warn, while the empty-array fallback (and the
 * underlying missing-table product decision) stays byte-for-byte
 * unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'live.ts');

describe('routes/live.ts — fetchLiveRoomAttendeesExcluding error logging', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const callSites = src.split('fetchLiveRoomAttendeesExcluding(supa,').slice(1);

  it('has exactly the two known call sites (room-ended summary + starting-soon follower notify)', () => {
    expect(callSites.length).toBe(2);
  });

  it('every call site destructures `error` from the call, not just `data`', () => {
    const matches = [...src.matchAll(/const \{ data: (\w+), error: (\w+) \} = await repo\.fetchLiveRoomAttendeesExcluding\(/g)];
    expect(matches.length).toBe(2);
  });

  it('every call site logs the error via console.warn when present, before falling back to an empty array', () => {
    for (const [, dataVar, errVar] of [...src.matchAll(/const \{ data: (\w+), error: (\w+) \} = await repo\.fetchLiveRoomAttendeesExcluding\(/g)]) {
      const idx = src.indexOf(`error: ${errVar} } = await repo.fetchLiveRoomAttendeesExcluding(`);
      const after = src.slice(idx, idx + 600);
      expect(after).toMatch(new RegExp(`if \\(${errVar}\\) \\{`));
      expect(after).toContain('console.warn(');
      // The fallback that swallows a missing/errored result must be
      // byte-for-byte unchanged: still `(x || []).map(...)`.
      expect(after).toContain(`(${dataVar} || []).map(`);
    }
  });
});
