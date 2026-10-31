/**
 * VTID-05216 — Project Manager DECIDE table tests (plan §6.2).
 *
 * The decide functions are PURE, so no DB or GitHub is needed: the observed
 * state is passed in. The merge rule is mutation-verified — a baseline all-true
 * case is merge-eligible, and flipping each precondition individually makes it
 * ineligible.
 */

import {
  decide,
  mergeDecision,
  parkDecision,
  reassignDecision,
  gate2Decisions,
} from '../../src/services/project-manager/decide';
import {
  AreaSeatRotation,
  CheckRun,
  ObservedLane,
  ObservedPr,
  ObservedState,
  ReviewEntry,
} from '../../src/services/project-manager/types';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const HOURS = (n: number) => n * 60 * 60 * 1000;
const ISO = (ms: number) => new Date(ms).toISOString();

const HEAD = 'abc123head';

function greenChecks(head = HEAD, extra: CheckRun[] = []): CheckRun[] {
  return [
    { name: 'Lane scope', conclusion: 'success', head_sha: head },
    { name: 'Collab handoff', conclusion: 'success', head_sha: head },
    ...extra,
  ];
}

function pr(overrides: Partial<ObservedPr> = {}): ObservedPr {
  return {
    url: 'https://github.com/exafyltd/vitana-platform/pull/9999',
    title: 'VTID-05216 (pm-agent/p3-observe-decide): Project Manager observe + decide (dry_run)',
    head_sha: HEAD,
    checks: greenChecks(),
    mergeable: true,
    merged: false,
    consecutive_ci_failures: 0,
    ...overrides,
  };
}

function approveReview(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    session_id: 'kiro-reviewer-202610151200-aaaa',
    reviewer_seat: 'exafyltd',
    verdict: 'approve',
    head_sha: HEAD,
    at: ISO(NOW - HOURS(1)),
    ...overrides,
  };
}

/** A lane that is fully merge-eligible (every precondition true). */
function mergeableLane(overrides: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'pm-agent',
    lane: 'p3-observe-decide',
    vtid: 'VTID-05216',
    state: 'verified',
    seat: 'jtadic',
    reviewer_seat: 'exafyltd',
    area: 'backoffice',
    paths: ['services/gateway/src/services/project-manager/**'],
    depends_on: [],
    pr: pr(),
    reviews: [approveReview()],
    executing_log: [
      { session_id: 'kiro-202610151621-4229', seat: 'jtadic', at: ISO(NOW - HOURS(5)) },
    ],
    state_since: ISO(NOW - HOURS(2)),
    last_branch_activity: ISO(NOW - HOURS(2)),
    claimed_at: ISO(NOW - HOURS(5)),
    seat_ran_automation_in_window: true,
    staging_verified: false,
    deploys: false,
    staging_verified_at: null,
    gate2_sent: false,
    ...overrides,
  };
}

function stateWith(lanes: ObservedLane[], rotations: AreaSeatRotation[] = []): ObservedState {
  return { mode: 'dry_run', lanes, rotations };
}

describe('mergeDecision — all preconditions true → merge-eligible', () => {
  it('the baseline lane is merge-eligible', () => {
    const lane = mergeableLane();
    const d = mergeDecision(lane, [lane]);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ kind: 'merge', vtid: 'VTID-05216', head_sha: HEAD });
  });
});

describe('mergeDecision — each precondition individually false → NO merge (mutation)', () => {
  it('lane not verified', () => {
    const lane = mergeableLane({ state: 'in-review' });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('no PR', () => {
    const lane = mergeableLane({ pr: null });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('no VTID on the lane', () => {
    const lane = mergeableLane({ vtid: null });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('no review entry', () => {
    const lane = mergeableLane({ reviews: [] });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('review from a different seat than reviewer_seat', () => {
    const lane = mergeableLane({ reviews: [approveReview({ reviewer_seat: 'jtadic' })] });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('review on a stale head sha (not current)', () => {
    const lane = mergeableLane({ reviews: [approveReview({ head_sha: 'oldsha000' })] });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('review verdict is changes, not approve', () => {
    const lane = mergeableLane({ reviews: [approveReview({ verdict: 'changes' })] });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('a required check (Lane scope) is not green', () => {
    const lane = mergeableLane({
      pr: pr({
        checks: [
          { name: 'Lane scope', conclusion: 'failure', head_sha: HEAD },
          { name: 'Collab handoff', conclusion: 'success', head_sha: HEAD },
        ],
      }),
    });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('a required check (Collab handoff) is missing on the head', () => {
    const lane = mergeableLane({
      pr: pr({ checks: [{ name: 'Lane scope', conclusion: 'success', head_sha: HEAD }] }),
    });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('a required check is green but on a different head sha', () => {
    const lane = mergeableLane({
      pr: pr({ checks: greenChecks('otherhead') }),
    });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('Claude Approvals App check exists but is not success', () => {
    const lane = mergeableLane({
      pr: pr({
        checks: greenChecks(HEAD, [
          { name: 'Claude Approvals', conclusion: 'failure', head_sha: HEAD },
        ]),
      }),
    });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('Claude Approvals App check present AND success → still merge-eligible', () => {
    const lane = mergeableLane({
      pr: pr({
        checks: greenChecks(HEAD, [
          { name: 'Claude Approvals', conclusion: 'success', head_sha: HEAD },
        ]),
      }),
    });
    expect(mergeDecision(lane, [lane])).not.toBeNull();
  });

  it('merge conflict (not mergeable)', () => {
    const lane = mergeableLane({ pr: pr({ mergeable: false }) });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('a depends_on lane is not done', () => {
    const lane = mergeableLane({ depends_on: ['p1-plan-spar'] });
    const dep: ObservedLane = mergeableLane({ lane: 'p1-plan-spar', state: 'in-review' });
    expect(mergeDecision(lane, [lane, dep])).toBeNull();
  });

  it('a depends_on lane IS done → merge-eligible', () => {
    const lane = mergeableLane({ depends_on: ['p1-plan-spar'] });
    const dep: ObservedLane = mergeableLane({ lane: 'p1-plan-spar', state: 'done' });
    expect(mergeDecision(lane, [lane, dep])).not.toBeNull();
  });

  it('PR title does not carry the lane VTID', () => {
    const lane = mergeableLane({ pr: pr({ title: 'some unrelated title' }) });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('lane declares no paths', () => {
    const lane = mergeableLane({ paths: [] });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });

  it('self-review residual: review session id appears in the executing log', () => {
    const lane = mergeableLane({
      reviews: [approveReview({ session_id: 'kiro-202610151621-4229' })],
    });
    expect(mergeDecision(lane, [lane])).toBeNull();
  });
});

describe('reassignDecision — stale ready / stale review', () => {
  const rotations: AreaSeatRotation[] = [
    { area: 'backoffice', seats: ['jtadic', 'exafyltd'] },
    { area: 'frontend', seats: ['exafyltd'] },
  ];

  it('ready <24h → no reassign', () => {
    const lane = mergeableLane({ state: 'ready', state_since: ISO(NOW - HOURS(10)), seat_ran_automation_in_window: false });
    expect(reassignDecision(lane, stateWith([lane], rotations), NOW)).toBeNull();
  });

  it('ready >24h but seat ran automation in window → no reassign', () => {
    const lane = mergeableLane({ state: 'ready', state_since: ISO(NOW - HOURS(30)), seat_ran_automation_in_window: true });
    expect(reassignDecision(lane, stateWith([lane], rotations), NOW)).toBeNull();
  });

  it('ready >24h, no automation → reassign to next seat for area', () => {
    // VTID-05414: reviewer_seat is not the next seat (a target equal to it is skipped, reassign-seat.test.ts).
    const lane = mergeableLane({ state: 'ready', seat: 'jtadic', reviewer_seat: 'hotmail', area: 'backoffice', state_since: ISO(NOW - HOURS(30)), seat_ran_automation_in_window: false });
    const d = reassignDecision(lane, stateWith([lane], rotations), NOW);
    expect(d).toMatchObject({ kind: 'reassign', target: 'lane', to_actor: 'exafyltd', reason: 'stale_ready' });
  });

  it('ready >24h, no next seat for area → claude', () => {
    const lane = mergeableLane({ state: 'ready', seat: 'exafyltd', area: 'frontend', state_since: ISO(NOW - HOURS(30)), seat_ran_automation_in_window: false });
    const d = reassignDecision(lane, stateWith([lane], rotations), NOW);
    expect(d).toMatchObject({ kind: 'reassign', to_actor: 'claude' });
  });

  it('review waiting >24h with no review entry → reassign review', () => {
    const lane = mergeableLane({ state: 'in-review', reviews: [], state_since: ISO(NOW - HOURS(30)) });
    const d = reassignDecision(lane, stateWith([lane], rotations), NOW);
    expect(d).toMatchObject({ kind: 'reassign', target: 'review', reason: 'stale_review' });
  });

  it('review waiting >24h but a review already exists → no reassign', () => {
    const lane = mergeableLane({ state: 'in-review', reviews: [approveReview()], state_since: ISO(NOW - HOURS(30)) });
    expect(reassignDecision(lane, stateWith([lane], rotations), NOW)).toBeNull();
  });

  it('review waiting <24h → no reassign', () => {
    const lane = mergeableLane({ state: 'in-review', reviews: [], state_since: ISO(NOW - HOURS(10)) });
    expect(reassignDecision(lane, stateWith([lane], rotations), NOW)).toBeNull();
  });
});

describe('parkDecision — 3 CI fails / risk flag / stale claim', () => {
  it('PR failed CI on 3 consecutive pushes → park', () => {
    const lane = mergeableLane({ state: 'executing', pr: pr({ consecutive_ci_failures: 3 }) });
    expect(parkDecision(lane, NOW)).toMatchObject({ kind: 'park', reason: 'ci_failed_3_consecutive', release_claim: false });
  });

  it('PR failed CI on only 2 pushes → no park', () => {
    const lane = mergeableLane({ state: 'executing', pr: pr({ consecutive_ci_failures: 2 }) });
    expect(parkDecision(lane, NOW)).toBeNull();
  });

  it('reviewer flagged risk → park', () => {
    const lane = mergeableLane({ state: 'in-review', reviews: [approveReview({ verdict: 'risk' })] });
    expect(parkDecision(lane, NOW)).toMatchObject({ kind: 'park', reason: 'reviewer_flagged_risk' });
  });

  it('claim >48h with no branch activity → park + release', () => {
    const lane = mergeableLane({
      state: 'executing',
      claimed_at: ISO(NOW - HOURS(50)),
      last_branch_activity: null,
      pr: pr({ consecutive_ci_failures: 0 }),
      reviews: [],
    });
    expect(parkDecision(lane, NOW)).toMatchObject({ kind: 'park', reason: 'stale_claim', release_claim: true });
  });

  it('claim >48h BUT with later branch activity → no park', () => {
    const lane = mergeableLane({
      state: 'executing',
      claimed_at: ISO(NOW - HOURS(50)),
      last_branch_activity: ISO(NOW - HOURS(1)),
      pr: pr({ consecutive_ci_failures: 0 }),
      reviews: [],
    });
    expect(parkDecision(lane, NOW)).toBeNull();
  });

  it('claim <48h → no park', () => {
    const lane = mergeableLane({
      state: 'executing',
      claimed_at: ISO(NOW - HOURS(10)),
      last_branch_activity: null,
      pr: pr({ consecutive_ci_failures: 0 }),
      reviews: [],
    });
    expect(parkDecision(lane, NOW)).toBeNull();
  });

  it('a done lane is never parked', () => {
    const lane = mergeableLane({ state: 'done', pr: pr({ consecutive_ci_failures: 5 }) });
    expect(parkDecision(lane, NOW)).toBeNull();
  });
});

describe('gate2Decisions — all-verified vs 4h-elapsed timing', () => {
  function deployingLane(overrides: Partial<ObservedLane> = {}): ObservedLane {
    return mergeableLane({
      state: 'done',
      deploys: true,
      staging_verified: false,
      staging_verified_at: null,
      gate2_sent: false,
      ...overrides,
    });
  }

  it('no lane verified yet → no gate2', () => {
    const a = deployingLane({ lane: 'a' });
    const b = deployingLane({ lane: 'b' });
    expect(gate2Decisions(stateWith([a, b]), NOW)).toHaveLength(0);
  });

  it('every deploying lane verified → gate2 (all_verified)', () => {
    const a = deployingLane({ lane: 'a', vtid: 'VTID-1', staging_verified: true, staging_verified_at: ISO(NOW - HOURS(1)) });
    const b = deployingLane({ lane: 'b', vtid: 'VTID-2', staging_verified: true, staging_verified_at: ISO(NOW - HOURS(1)) });
    const out = gate2Decisions(stateWith([a, b]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'gate2', reason: 'all_verified' });
    expect(out[0].vtids.sort()).toEqual(['VTID-1', 'VTID-2']);
  });

  it('one verified, one not, <4h since first → no gate2', () => {
    const a = deployingLane({ lane: 'a', staging_verified: true, staging_verified_at: ISO(NOW - HOURS(2)) });
    const b = deployingLane({ lane: 'b', staging_verified: false });
    expect(gate2Decisions(stateWith([a, b]), NOW)).toHaveLength(0);
  });

  it('one verified, one not, >4h since first → gate2 (four_hours_elapsed)', () => {
    const a = deployingLane({ lane: 'a', vtid: 'VTID-1', staging_verified: true, staging_verified_at: ISO(NOW - HOURS(5)) });
    const b = deployingLane({ lane: 'b', vtid: 'VTID-2', staging_verified: false });
    const out = gate2Decisions(stateWith([a, b]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'gate2', reason: 'four_hours_elapsed' });
    // only the verified lane's VTID is batched.
    expect(out[0].vtids).toEqual(['VTID-1']);
  });

  it('gate2 already sent → not re-sent', () => {
    const a = deployingLane({ lane: 'a', staging_verified: true, staging_verified_at: ISO(NOW - HOURS(5)), gate2_sent: true });
    expect(gate2Decisions(stateWith([a]), NOW)).toHaveLength(0);
  });

  it('non-deploying lanes are ignored (no gate2)', () => {
    const a = deployingLane({ lane: 'a', deploys: false, staging_verified: true, staging_verified_at: ISO(NOW - HOURS(5)) });
    expect(gate2Decisions(stateWith([a]), NOW)).toHaveLength(0);
  });
});

describe('decide — orchestration + mode gating + precedence', () => {
  it('mode off → no decisions at all', () => {
    const lane = mergeableLane();
    const state: ObservedState = { mode: 'off', lanes: [lane], rotations: [] };
    expect(decide(state, NOW)).toHaveLength(0);
  });

  it('park takes precedence over merge for a troubled verified lane', () => {
    // verified + merge-eligible, but reviewer flagged risk → park wins.
    const lane = mergeableLane({ reviews: [approveReview({ verdict: 'risk' })] });
    const out = decide(stateWith([lane]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('park');
  });

  it('a clean merge-eligible lane yields exactly one merge decision', () => {
    const lane = mergeableLane();
    const out = decide(stateWith([lane]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('merge');
  });

  it('merge + gate2 can both appear for different lanes', () => {
    const mergeLane = mergeableLane({ lane: 'p3', deploys: false });
    const gate2Lane = mergeableLane({
      lane: 'p7', state: 'done', deploys: true, vtid: 'VTID-9',
      staging_verified: true, staging_verified_at: ISO(NOW - HOURS(1)),
    });
    const out = decide(stateWith([mergeLane, gate2Lane]), NOW);
    const kinds = out.map((d) => d.kind).sort();
    expect(kinds).toEqual(['gate2', 'merge']);
  });
});
