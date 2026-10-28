/**
 * VTID-05387 (operating-workflow/pm-noop, sparring R1-F3): the PM never writes a
 * lane permission key. On a `pm-agent` bookkeeping PR, Lane scope's PERM rule
 * (scripts/collab/queue.mjs:678-684) refuses any change of `executor`, `seat`,
 * `reviewer_seat` or `paths` (the pm-agent session is excluded from the
 * Claude-only set), so such a write keeps its PR red forever and the PM re-decides
 * it every tick. The decider therefore makes no stale-ready decision that would
 * change `seat`, `applyLaneChange` refuses a permission-key change, and the act
 * layer never passes `seat`.
 */
import { reassignDecision } from '../../src/services/project-manager/decide';
import { applyLaneChange } from '../../src/services/project-manager/writers';
import { actOnDecisions, type ActDeps, type LaneFileChange } from '../../src/services/project-manager/act';
import type { LeaseManager } from '../../src/services/project-manager/lease';

const GRANT: LeaseManager = { acquire: async () => ({ acquired: true }) } as unknown as LeaseManager;
import type {
  AreaSeatRotation,
  ObservedClaude,
  ObservedLane,
  ObservedState,
  ParkDecision,
  ReassignDecision,
} from '../../src/services/project-manager/types';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const HOUR = 3600_000;
const UNAVAILABLE: ObservedClaude = { flag: false, oldest_assigned_at: null, last_action_at: null };
const AVAILABLE: ObservedClaude = { flag: true, oldest_assigned_at: null, last_action_at: new Date(NOW - HOUR).toISOString() };

function lane(o: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'demo', lane: 'l1', vtid: 'VTID-09001', state: 'ready', seat: 'exafy', reviewer_seat: 'exafyltd',
    area: 'platform', paths: ['services/gateway/src/services/demo/**'], depends_on: [], pr: null, reviews: [],
    executing_log: [], state_since: new Date(NOW - 30 * HOUR).toISOString(), last_branch_activity: null,
    claimed_at: null, seat_ran_automation_in_window: false, staging_verified: false, deploys: false,
    staging_verified_at: null, gate2_sent: false,
    ...o,
  } as ObservedLane;
}
const st = (l: ObservedLane, rotations: AreaSeatRotation[], claude: ObservedClaude): ObservedState => ({
  mode: 'live', lanes: [l], rotations, claude,
});

describe('stale-ready never changes seat', () => {
  // decide → act with a recorder: whatever the target, the write carries no `seat`.
  async function writesFor(l: ObservedLane, rot: AreaSeatRotation[], claude: ObservedClaude): Promise<LaneFileChange[]> {
    const d = reassignDecision(l, st(l, rot, claude), NOW);
    const writes: LaneFileChange[] = [];
    if (!d) return writes;
    process.env.PM_MODE = 'live';
    await actOnDecisions([d], st(l, rot, claude), {
      safeMerge: async () => { throw new Error('no merge expected'); },
      laneWriter: { write: async (c: LaneFileChange) => { writes.push(c); return 'written' as const; } },
      gate2Poster: { post: async () => undefined },
      gate2Evidence: { resolve: async () => ({ verified_commit: 'v', production_commit: 'p', commits: [] }) },
      lease: GRANT,
    });
    return writes;
  }
  it('only the exceptions seat is left (Claude unavailable) → next_actor only, no seat', async () => {
    const w = await writesFor(lane(), [{ area: 'platform', seats: ['exafy'] }], UNAVAILABLE);
    expect(w).toHaveLength(1);
    expect(w[0].seat).toBeUndefined();
  });
  it('a next seat in the rotation → next_actor only, no seat', async () => {
    const w = await writesFor(lane(), [{ area: 'platform', seats: ['exafy', 'exafyltd', 'jtadic'] }], AVAILABLE);
    expect(w).toHaveLength(1);
    expect(w[0].seat).toBeUndefined();
  });
  it('end of rotation with Claude available → claude, seat unchanged', async () => {
    const l = lane();
    const d = reassignDecision(l, st(l, [{ area: 'platform', seats: ['exafy'] }], AVAILABLE), NOW);
    expect(d).toMatchObject({ kind: 'reassign', target: 'lane', to_actor: 'claude', reason: 'stale_ready' });
    const w = await writesFor(l, [{ area: 'platform', seats: ['exafy'] }], AVAILABLE);
    expect(w[0]).toMatchObject({ next_actor: 'claude' });
    expect(w[0].seat).toBeUndefined();
  });
});

const TEXT = `---
lane: l1
state: ready
next_actor: kiro
executor: kiro
seat: exafy
reviewer_seat: exafyltd
paths:
  - services/gateway/src/services/demo/**
updated: 2026-10-27T10:00Z
---
## Log
`;

describe('applyLaneChange refuses a permission-key change', () => {
  const base: LaneFileChange = { slug: 'demo', lane: 'l1', log: 'x' };
  it('seat changed → throws', () => {
    expect(() => applyLaneChange(TEXT, { ...base, seat: 'exafyltd' }, '2026-10-28T12:00:00.000Z')).toThrow(/permission key seat/);
  });
  it('seat equal to the current seat → allowed (no change)', () => {
    expect(applyLaneChange(TEXT, { ...base, seat: 'exafy', state: 'parked' }, '2026-10-28T12:00:00.000Z')).toMatch(/^seat: exafy$/m);
  });
  it('state / next_actor / claim changes are still allowed', () => {
    const out = applyLaneChange(TEXT, { ...base, state: 'parked', next_actor: 'owner', release_claim: true }, '2026-10-28T12:00:00.000Z');
    expect(out).toMatch(/^state: parked$/m);
    expect(out).toMatch(/^next_actor: owner$/m);
  });
});

describe('the act layer never passes seat', () => {
  function deps(writes: LaneFileChange[]): ActDeps {
    return {
      safeMerge: async () => { throw new Error('no merge expected'); },
      laneWriter: { write: async (c: LaneFileChange) => { writes.push(c); return 'written' as const; } },
      gate2Poster: { post: async () => undefined },
      gate2Evidence: { resolve: async () => ({ verified_commit: 'v', production_commit: 'p', commits: [] }) },
      lease: GRANT,
    };
  }
  it('reassign (lane target to a seat, e.g. from an older decider) writes next_actor only', async () => {
    process.env.PM_MODE = 'live';
    const writes: LaneFileChange[] = [];
    const d: ReassignDecision = { kind: 'reassign', slug: 'demo', lane: 'l1', target: 'lane', from_seat: 'exafy', to_actor: 'exafyltd', reason: 'stale_ready', window_ms: 7200000, fallback: true };
    await actOnDecisions([d], { mode: 'live', lanes: [lane()], rotations: [] }, deps(writes));
    expect(writes[0].seat).toBeUndefined();
  });
  it('park to the exceptions seat writes next_actor only', async () => {
    process.env.PM_MODE = 'live';
    const writes: LaneFileChange[] = [];
    const d: ParkDecision = { kind: 'park', slug: 'demo', lane: 'l1', reason: 'stale_claim', window_ms: 172800000, release_claim: true, to_actor: 'exafyltd', fallback: true } as ParkDecision;
    await actOnDecisions([d], { mode: 'live', lanes: [lane({ state: 'executing' })], rotations: [] }, deps(writes));
    expect(writes[0]).toMatchObject({ state: 'parked', next_actor: 'exafyltd' });
    expect(writes[0].seat).toBeUndefined();
  });
});
