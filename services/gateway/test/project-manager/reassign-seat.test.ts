/**
 * VTID-05414 (pm-reassign-idempotent-r2/reassign-noop-r2) — the stale-ready
 * reassignment never makes a lane's `seat` equal its `reviewer_seat`
 * (scripts/collab/queue.mjs validateLane rejects that lane file), and the
 * writer refuses a change that would introduce it.
 */
import { reassignDecision } from '../../src/services/project-manager/decide';
import { applyLaneChange } from '../../src/services/project-manager/writers';
import type { AreaSeatRotation, ObservedClaude, ObservedLane, ObservedState } from '../../src/services/project-manager/types';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const HOUR = 3600_000;
const ISO = (ms: number) => new Date(ms).toISOString();
const UNAVAILABLE: ObservedClaude = { flag: false, oldest_assigned_at: null, last_action_at: null };
const AVAILABLE: ObservedClaude = { flag: true, oldest_assigned_at: null, last_action_at: ISO(NOW - HOUR) };

function lane(o: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'demo',
    lane: 'l1',
    vtid: 'VTID-09001',
    state: 'ready',
    seat: 'exafy',
    reviewer_seat: 'exafyltd',
    area: 'platform',
    paths: ['services/gateway/src/services/demo/**'],
    depends_on: [],
    pr: null,
    reviews: [],
    executing_log: [],
    state_since: ISO(NOW - 30 * HOUR),
    last_branch_activity: null,
    claimed_at: null,
    seat_ran_automation_in_window: false,
    staging_verified: false,
    deploys: false,
    staging_verified_at: null,
    gate2_sent: false,
    ...o,
  };
}

const st = (l: ObservedLane, seats: string[], claude: ObservedClaude): ObservedState => {
  const rotations: AreaSeatRotation[] = [{ area: 'platform', seats }];
  return { mode: 'live', lanes: [l], rotations, claude };
};

describe('VTID-05414 stale-ready target is never the reviewer_seat', () => {
  it('rotation [exafy], Claude unavailable, reviewer_seat exafyltd → no decision', () => {
    const l = lane();
    expect(reassignDecision(l, st(l, ['exafy'], UNAVAILABLE), NOW)).toBeNull();
  });

  it('rotation [exafy, exafyltd, jtadic] → skips exafyltd, to_actor jtadic', () => {
    const l = lane();
    expect(reassignDecision(l, st(l, ['exafy', 'exafyltd', 'jtadic'], UNAVAILABLE), NOW))
      .toMatchObject({ kind: 'reassign', reason: 'stale_ready', to_actor: 'jtadic', fallback: false });
  });

  it('Claude available → to_actor claude (seat unchanged by act)', () => {
    const l = lane();
    expect(reassignDecision(l, st(l, ['exafy'], AVAILABLE), NOW)).toMatchObject({ to_actor: 'claude', fallback: false });
  });

  it('no reviewer_seat → the exceptions seat as today', () => {
    const l = lane({ reviewer_seat: '' });
    expect(reassignDecision(l, st(l, ['exafy'], UNAVAILABLE), NOW)).toMatchObject({ to_actor: 'exafyltd', fallback: true });
  });

  it('reviewer agent as reviewer_seat → the exceptions seat as today', () => {
    const l = lane({ reviewer_seat: 'agent:vitana-lane-reviewer' });
    expect(reassignDecision(l, st(l, ['exafy'], UNAVAILABLE), NOW)).toMatchObject({ to_actor: 'exafyltd' });
  });
});

const LANE = `---
lane: l1
state: ready
next_actor: kiro
executor: kiro
seat: exafy
area: platform
reviewer_seat: exafyltd
updated: 2026-10-28T10:00Z
---
# l1
## Log
### 2026-10-28T10:00Z · kiro-exafy-202610281000-aaaa · ready
Created.
`;

describe('VTID-05414 applyLaneChange refuses seat == reviewer_seat', () => {
  it('a change that makes seat equal reviewer_seat throws', () => {
    expect(() => applyLaneChange(LANE, { slug: 'demo', lane: 'l1', seat: 'exafyltd', next_actor: 'exafyltd', log: 'reassign lane exafy→exafyltd (stale_ready)' }, '2026-10-28T12:00:00.000Z'))
      .toThrow('invalid lane change: seat equals reviewer_seat');
  });

  it('a lane that already has seat == reviewer_seat still takes a park', () => {
    const bad = LANE.replace('seat: exafy\n', 'seat: exafyltd\n');
    const out = applyLaneChange(bad, { slug: 'demo', lane: 'l1', state: 'parked', next_actor: 'exafyltd', seat: 'exafyltd', log: 'park (ci_failed_3_consecutive)' }, '2026-10-28T12:00:00.000Z');
    expect(out).toMatch(/^state: parked$/m);
  });

  it('a next_actor-only change on such a lane does not throw', () => {
    const bad = LANE.replace('seat: exafy\n', 'seat: exafyltd\n');
    expect(() => applyLaneChange(bad, { slug: 'demo', lane: 'l1', next_actor: 'claude', log: 'reassign review' }, '2026-10-28T12:00:00.000Z')).not.toThrow();
  });
});
