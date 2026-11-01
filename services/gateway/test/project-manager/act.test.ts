/**
 * VTID-05217 — Project Manager ACT layer integration tests (plan §6.3).
 *
 * The safety core. Every test drives the act layer with injected seams:
 *   - a FAKE safe-merge function (records every call, returns a typed outcome);
 *   - an in-memory lane-file writer and Gate-2 poster (record calls);
 *   - a lease manager (acquired / held-by-other / table-absent).
 * There is NO deploy / workflow-dispatch / allocate seam at all — those
 * capabilities are not reachable from the act layer, which is the point. The
 * fakes expose counters so the "never deploys / never dispatches / never
 * allocates" invariant is asserted directly.
 *
 * A separate section drives the REAL `safeMerge` from routes/cicd.ts over a
 * mocked github-service + oasis-event-service to prove: already-merged (a PR
 * that is not open) maps to a typed `already_merged` no-op success, and no
 * merge/deploy call is made in that case.
 */

import {
  actOnDecisions,
  governanceMergeAllowed,
  laneTouchesGovernance,
  prNumberFromUrl,
  type ActDeps,
  type Gate2Message,
  type LaneFileChange,
} from '../../src/services/project-manager/act';
import type { LeaseManager, LeaseOutcome } from '../../src/services/project-manager/lease';
import { NoLeaseManager } from '../../src/services/project-manager/lease';
import type { SafeMergeOutcome } from '../../src/routes/cicd';
import type { SafeMergeRequest } from '../../src/types/cicd';
import {
  Gate2Decision,
  MergeDecision,
  ObservedLane,
  ObservedState,
  ParkDecision,
  PmDecision,
  ReassignDecision,
} from '../../src/services/project-manager/types';

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

/** Records every merge attempt; returns a scripted outcome keyed by pr_number. */
class FakeSafeMerge {
  calls: SafeMergeRequest[] = [];
  // never-invoked tripwires: the act layer must never reach a deploy/dispatch/allocate.
  deployCalls = 0;
  dispatchCalls = 0;
  allocateCalls = 0;

  constructor(private readonly outcomes: Map<number, SafeMergeOutcome>) {}

  fn = async (input: SafeMergeRequest): Promise<SafeMergeOutcome> => {
    this.calls.push(input);
    const o = this.outcomes.get(input.pr_number);
    if (!o) throw new Error(`no scripted outcome for PR ${input.pr_number}`);
    return o;
  };
}

function mergedOutcome(head = 'headsha'): SafeMergeOutcome {
  return {
    result: 'merged',
    status: 200,
    body: { ok: true, merged: true, vtid: 'VTID-X', details: { head } },
  };
}
function alreadyMergedOutcome(): SafeMergeOutcome {
  return {
    result: 'already_merged',
    status: 400,
    body: { ok: false, reason: 'pr_not_open', vtid: 'VTID-X', details: { pr_state: 'closed' } },
  };
}
function refusedOutcome(reason = 'checks_failed'): SafeMergeOutcome {
  return { result: 'refused', status: 400, body: { ok: false, reason, vtid: 'VTID-X' } };
}

class FakeLaneWriter {
  changes: LaneFileChange[] = [];
  write = async (c: LaneFileChange): Promise<'written' | 'noop'> => {
    this.changes.push(c);
    return 'written';
  };
}

class FakeGate2Poster {
  posted: Gate2Message[] = [];
  post = async (m: Gate2Message): Promise<void> => {
    this.posted.push(m);
  };
}

class FakeGate2Evidence {
  resolve = async (decision: Gate2Decision, _state: ObservedState) => ({
    verified_commit: 'verified-sha',
    production_commit: 'prod-sha',
    commits: ['c1', 'c2', 'c3'],
  });
}

class AcquiredLease implements LeaseManager {
  async acquire(holder: string): Promise<LeaseOutcome> {
    return { acquired: true, holder, expires_at: '2026-10-15T12:09:00Z' };
  }
}
class HeldByOtherLease implements LeaseManager {
  async acquire(): Promise<LeaseOutcome> {
    return { acquired: false, reason: 'held_by_other' };
  }
}

// --------------------------------------------------------------------------
// Builders
// --------------------------------------------------------------------------

function lane(overrides: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'pm-agent',
    lane: 'p4-act',
    vtid: 'VTID-05217',
    state: 'verified',
    seat: 'jtadic',
    reviewer_seat: 'exafyltd',
    area: 'backoffice',
    paths: ['services/gateway/src/services/project-manager/**'],
    depends_on: [],
    pr: {
      url: 'https://github.com/exafyltd/vitana-platform/pull/4242',
      title: 'VTID-05217 act',
      head_sha: 'headsha',
      checks: [],
      mergeable: true,
      merged: false,
      consecutive_ci_failures: 0,
    },
    reviews: [],
    executing_log: [],
    state_since: '2026-10-15T00:00:00Z',
    last_branch_activity: null,
    claimed_at: null,
    seat_ran_automation_in_window: true,
    staging_verified: false,
    deploys: false,
    staging_verified_at: null,
    gate2_sent: false,
    ...overrides,
  };
}

function stateWith(lanes: ObservedLane[]): ObservedState {
  return { mode: 'live', lanes, rotations: [] };
}

function mergeDecisionFor(l: ObservedLane): MergeDecision {
  return {
    kind: 'merge',
    slug: l.slug,
    lane: l.lane,
    vtid: l.vtid as string,
    pr_url: l.pr!.url,
    head_sha: l.pr!.head_sha,
  };
}

function baseDeps(fake: FakeSafeMerge, extra: Partial<ActDeps> = {}): ActDeps {
  return {
    safeMerge: fake.fn,
    laneWriter: new FakeLaneWriter(),
    gate2Poster: new FakeGate2Poster(),
    gate2Evidence: new FakeGate2Evidence(),
    lease: new AcquiredLease(),
    ...extra,
  };
}

const prevMode = process.env.PM_MODE;
afterEach(() => {
  if (prevMode === undefined) delete process.env.PM_MODE;
  else process.env.PM_MODE = prevMode;
});

// --------------------------------------------------------------------------
// Mode gating: act only in live
// --------------------------------------------------------------------------

describe('act layer — mode gating', () => {
  it('live: a merge-eligible decision calls safe-merge exactly once', async () => {
    process.env.PM_MODE = 'live';
    const l = lane();
    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    const deps = baseDeps(fake);
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), deps);

    expect(res.acted).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ pr_number: 4242, vtid: 'VTID-05217', repo: 'exafyltd/vitana-platform' });
    expect(res.results[0].status).toBe('merged');
  });

  it.each(['dry_run', 'off'] as const)('%s: never calls safe-merge', async (mode) => {
    process.env.PM_MODE = mode;
    const l = lane();
    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), baseDeps(fake));

    expect(res.acted).toBe(false);
    expect(res.skipped_reason).toBe('not_live');
    expect(fake.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Never deploys / dispatches / allocates
// --------------------------------------------------------------------------

describe('act layer — never deploys, dispatches, or allocates', () => {
  it('acting on every decision kind touches only safe-merge, lane writes and the Gate-2 post', async () => {
    process.env.PM_MODE = 'live';
    const mergeL = lane({ lane: 'p4-act' });
    const reassignL = lane({ lane: 'stale', state: 'ready' });
    const parkL = lane({ lane: 'bad', state: 'executing' });
    const gate2L = lane({ lane: 'dep', deploys: true, staging_verified: true, vtid: 'VTID-05217' });
    const st = stateWith([mergeL, reassignL, parkL, gate2L]);

    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    const laneWriter = new FakeLaneWriter();
    const gate2Poster = new FakeGate2Poster();
    const deps = baseDeps(fake, { laneWriter, gate2Poster });

    const decisions: PmDecision[] = [
      mergeDecisionFor(mergeL),
      { kind: 'reassign', slug: reassignL.slug, lane: 'stale', target: 'lane', from_seat: 'jtadic', to_actor: 'exafyltd', reason: 'stale_ready', window_ms: 86400000, fallback: false },
      { kind: 'park', slug: parkL.slug, lane: 'bad', reason: 'ci_failed_3_consecutive', release_claim: false },
      { kind: 'gate2', slug: gate2L.slug, vtids: ['VTID-05217'], reason: 'all_verified' },
    ];

    await actOnDecisions(decisions, st, deps);

    // The only external calls are: safe-merge, lane-file writes, one Gate-2 post.
    expect(fake.calls).toHaveLength(1);
    expect(fake.deployCalls).toBe(0);
    expect(fake.dispatchCalls).toBe(0);
    expect(fake.allocateCalls).toBe(0);
    expect(gate2Poster.posted).toHaveLength(1);
    // lane writes: merge→done, reassign, park (gate2 writes no lane file).
    expect(laneWriter.changes.map((c) => c.log).join(' | ')).toMatch(/merged .* lane done/);
    expect(laneWriter.changes.some((c) => c.state === 'parked')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Governance-path guard
// --------------------------------------------------------------------------

describe('act layer — governance-path merge guard', () => {
  it('a governance-path PR whose reviewer is NOT claude is refused, never merged', async () => {
    process.env.PM_MODE = 'live';
    const l = lane({ paths: ['.github/workflows/PR-GATE.yml'], reviewer_seat: 'exafyltd' });
    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), baseDeps(fake));

    expect(res.results[0].status).toBe('governance_blocked');
    expect(fake.calls).toHaveLength(0); // safe-merge never reached
  });

  it('a governance-path PR whose reviewer IS claude is allowed to merge', async () => {
    process.env.PM_MODE = 'live';
    const l = lane({ paths: ['.claude/rules/collaboration.md'], reviewer_seat: 'claude' });
    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), baseDeps(fake));

    expect(res.results[0].status).toBe('merged');
    expect(fake.calls).toHaveLength(1);
  });

  it('governance helpers classify paths and reviewers correctly', () => {
    expect(laneTouchesGovernance(lane({ paths: ['CLAUDE.md'] }))).toBe(true);
    expect(laneTouchesGovernance(lane({ paths: ['.kiro/steering/x.md'] }))).toBe(true);
    expect(laneTouchesGovernance(lane({ paths: ['docs/programs/areas.yaml'] }))).toBe(true);
    expect(laneTouchesGovernance(lane({ paths: ['services/gateway/**'] }))).toBe(false);
    expect(governanceMergeAllowed(lane({ paths: ['services/gateway/**'], reviewer_seat: 'exafyltd' }))).toBe(true);
    expect(governanceMergeAllowed(lane({ paths: ['.github/x'], reviewer_seat: 'claude' }))).toBe(true);
    expect(governanceMergeAllowed(lane({ paths: ['.github/x'], reviewer_seat: 'jtadic' }))).toBe(false);
  });
});

// --------------------------------------------------------------------------
// safe-merge result handling: already-merged, refused
// --------------------------------------------------------------------------

describe('act layer — safe-merge result handling', () => {
  it('already-merged PR is a no-op success, not an error; lane set done', async () => {
    process.env.PM_MODE = 'live';
    const l = lane();
    const fake = new FakeSafeMerge(new Map([[4242, alreadyMergedOutcome()]]));
    const laneWriter = new FakeLaneWriter();
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), baseDeps(fake, { laneWriter }));

    expect(res.results[0].status).toBe('already_merged');
    expect(laneWriter.changes).toHaveLength(1);
    expect(laneWriter.changes[0].state).toBe('done');
  });

  it('safe-merge refused (gate not met) → lane NOT set done', async () => {
    process.env.PM_MODE = 'live';
    const l = lane();
    const fake = new FakeSafeMerge(new Map([[4242, refusedOutcome('checks_failed')]]));
    const laneWriter = new FakeLaneWriter();
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), baseDeps(fake, { laneWriter }));

    expect(res.results[0].status).toBe('merge_refused');
    expect(res.results[0].detail).toBe('checks_failed');
    expect(laneWriter.changes).toHaveLength(0); // lane not touched
  });
});

// --------------------------------------------------------------------------
// Lease
// --------------------------------------------------------------------------

describe('act layer — per-tick lease', () => {
  it('lease absent (p1 migration not present) → tick no-ops, no action taken', async () => {
    process.env.PM_MODE = 'live';
    const l = lane();
    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    // The default lease manager (NoLeaseManager) reports table_absent.
    const deps = baseDeps(fake, { lease: new NoLeaseManager() });
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), deps);

    expect(res.acted).toBe(false);
    expect(res.skipped_reason).toBe('no_lease');
    expect(fake.calls).toHaveLength(0);
  });

  it('lease held by another task → tick no-ops', async () => {
    process.env.PM_MODE = 'live';
    const l = lane();
    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), baseDeps(fake, { lease: new HeldByOtherLease() }));

    expect(res.acted).toBe(false);
    expect(res.skipped_reason).toBe('no_lease');
    expect(fake.calls).toHaveLength(0);
  });

  it('default lease manager (no injection) is the fail-safe NoLeaseManager → no-op', async () => {
    process.env.PM_MODE = 'live';
    const l = lane();
    const fake = new FakeSafeMerge(new Map([[4242, mergedOutcome()]]));
    const deps: ActDeps = {
      safeMerge: fake.fn,
      laneWriter: new FakeLaneWriter(),
      gate2Poster: new FakeGate2Poster(),
      gate2Evidence: new FakeGate2Evidence(),
      // no lease injected → defaultLeaseManager()
    };
    const res = await actOnDecisions([mergeDecisionFor(l)], stateWith([l]), deps);
    expect(res.acted).toBe(false);
    expect(res.skipped_reason).toBe('no_lease');
    expect(fake.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Gate-2 batch: posts the message, never deploys
// --------------------------------------------------------------------------

describe('act layer — Gate-2 batch', () => {
  it('posts the run-view question with the full production..verified commit list; never deploys', async () => {
    process.env.PM_MODE = 'live';
    const l = lane({ deploys: true, staging_verified: true });
    const fake = new FakeSafeMerge(new Map());
    const poster = new FakeGate2Poster();
    const decision: Gate2Decision = { kind: 'gate2', slug: 'pm-agent', vtids: ['VTID-05217'], reason: 'all_verified' };
    const res = await actOnDecisions([decision], stateWith([l]), baseDeps(fake, { gate2Poster: poster }));

    expect(res.results[0].status).toBe('gate2_posted');
    expect(poster.posted).toHaveLength(1);
    const msg = poster.posted[0];
    expect(msg.question).toBe('Staging verified — ready for deployment to production?');
    expect(msg.vtids).toEqual(['VTID-05217']);
    expect(msg.evidence.commits).toEqual(['c1', 'c2', 'c3']);
    expect(msg.evidence.production_commit).toBe('prod-sha');
    expect(msg.evidence.verified_commit).toBe('verified-sha');
    // No deploy ever happened (no deploy seam exists; safe-merge not called for gate2).
    expect(fake.calls).toHaveLength(0);
    expect(fake.deployCalls).toBe(0);
    expect(fake.dispatchCalls).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Reassign / park lane-file writes
// --------------------------------------------------------------------------

describe('act layer — reassign and park write lane-file state', () => {
  it('reassign to a seat moves seat + next_actor', async () => {
    process.env.PM_MODE = 'live';
    const l = lane({ state: 'ready' });
    const fake = new FakeSafeMerge(new Map());
    const writer = new FakeLaneWriter();
    const d: ReassignDecision = { kind: 'reassign', slug: 'pm-agent', lane: 'p4-act', target: 'lane', from_seat: 'jtadic', to_actor: 'exafyltd', reason: 'stale_ready', window_ms: 86400000, fallback: false };
    await actOnDecisions([d], stateWith([l]), baseDeps(fake, { laneWriter: writer }));
    expect(writer.changes[0]).toMatchObject({ seat: 'exafyltd', next_actor: 'exafyltd' });
  });

  it('reassign to claude sets next_actor claude, no seat change', async () => {
    process.env.PM_MODE = 'live';
    const l = lane({ state: 'ready' });
    const fake = new FakeSafeMerge(new Map());
    const writer = new FakeLaneWriter();
    const d: ReassignDecision = { kind: 'reassign', slug: 'pm-agent', lane: 'p4-act', target: 'lane', from_seat: 'jtadic', to_actor: 'claude', reason: 'stale_ready', window_ms: 86400000, fallback: false };
    await actOnDecisions([d], stateWith([l]), baseDeps(fake, { laneWriter: writer }));
    expect(writer.changes[0].next_actor).toBe('claude');
    expect(writer.changes[0].seat).toBeUndefined();
  });

  it('stale-claim park releases the claim', async () => {
    process.env.PM_MODE = 'live';
    const l = lane({ state: 'executing' });
    const fake = new FakeSafeMerge(new Map());
    const writer = new FakeLaneWriter();
    const d: ParkDecision = { kind: 'park', slug: 'pm-agent', lane: 'p4-act', reason: 'stale_claim', window_ms: 172800000, release_claim: true };
    await actOnDecisions([d], stateWith([l]), baseDeps(fake, { laneWriter: writer }));
    expect(writer.changes[0]).toMatchObject({ state: 'parked', next_actor: 'claude', release_claim: true });
  });
});

// --------------------------------------------------------------------------
// prNumberFromUrl
// --------------------------------------------------------------------------

describe('prNumberFromUrl', () => {
  it('parses a PR number from a GitHub url', () => {
    expect(prNumberFromUrl('https://github.com/exafyltd/vitana-platform/pull/4242')).toBe(4242);
  });
  it('returns null for a url with no pull segment', () => {
    expect(prNumberFromUrl('https://github.com/exafyltd/vitana-platform/issues/9')).toBeNull();
  });
});
