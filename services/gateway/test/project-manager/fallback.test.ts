/**
 * VTID-05274 — Claude optional: the PM falls back to the exceptions seat, plus
 * the speed rules (plan kiro-autonomy-fallback §3, §5 C2-C4).
 *
 * T1-T8 availability + fallback routing, T13-T22 timers / merge queue / plan
 * merge / Gate 2 / tick / ledger, M6 (Claude available keeps today's routing),
 * M7 (no deploy / dispatch / allocate reachable from any new decision kind).
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  bookkeepingMergeDecision,
  buildLanesInFlight,
  claudeAvailability,
  decide,
  gate2Decisions,
  ledgerDecision,
  parkDecision,
  planMergeDecision,
  reassignDecision,
} from '../../src/services/project-manager/decide';
import { actOnDecisions, type ActDeps } from '../../src/services/project-manager/act';
import { pmLeaseTtlMs, pmTickIntervalMs } from '../../src/services/project-manager/config';
import type { LeaseManager, LeaseOutcome } from '../../src/services/project-manager/lease';
import type { SafeMergeRequest } from '../../src/types/cicd';
import {
  EXCEPTIONS_SEAT,
  REASSIGN_NO_DRIVER_AFTER_MS,
  type AreaSeatRotation,
  type ObservedBookkeepingPr,
  type ObservedClaude,
  type ObservedLane,
  type ObservedPlanPr,
  type ObservedState,
  type PmDecision,
} from '../../src/services/project-manager/types';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3600_000;
const ISO = (ms: number) => new Date(ms).toISOString();
const HEAD = 'd'.repeat(40);

const UNAVAILABLE: ObservedClaude = { flag: false, oldest_assigned_at: null, last_action_at: null };
const AVAILABLE: ObservedClaude = { flag: true, oldest_assigned_at: null, last_action_at: ISO(NOW - HOUR) };

function lane(o: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'demo',
    lane: 'l1',
    vtid: 'VTID-09001',
    state: 'ready',
    seat: 'exafy',
    reviewer_seat: 'jtadic',
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

const ROT: AreaSeatRotation[] = [{ area: 'platform', seats: ['exafy'] }];
const st = (lanes: ObservedLane[], claude?: ObservedClaude, extra: Partial<ObservedState> = {}): ObservedState => ({
  mode: 'live', lanes, rotations: ROT, ...(claude ? { claude } : {}), ...extra,
});

describe('T1-T4 claudeAvailability (plan §3)', () => {
  it('T1 flag false → unavailable, flag_false', () => {
    expect(claudeAvailability(UNAVAILABLE, NOW)).toEqual({ available: false, reason: 'flag_false' });
  });
  it('T2 oldest item 5 h old, last Claude action 6 h ago → no_action_4h', () => {
    const c = { flag: null, oldest_assigned_at: ISO(NOW - 5 * HOUR), last_action_at: ISO(NOW - 6 * HOUR) };
    expect(claudeAvailability(c, NOW)).toEqual({ available: false, reason: 'no_action_4h' });
  });
  it('T2b flag true does not override the 4 h rule', () => {
    const c = { flag: true, oldest_assigned_at: ISO(NOW - 5 * HOUR), last_action_at: null };
    expect(claudeAvailability(c, NOW)).toEqual({ available: false, reason: 'no_action_4h' });
  });
  it('T3 oldest item 3 h old → available', () => {
    const c = { flag: null, oldest_assigned_at: ISO(NOW - 3 * HOUR), last_action_at: null };
    expect(claudeAvailability(c, NOW)).toEqual({ available: true, reason: null });
  });
  it('T4 item 5 h old but Claude acted 1 h ago → available', () => {
    const c = { flag: null, oldest_assigned_at: ISO(NOW - 5 * HOUR), last_action_at: ISO(NOW - HOUR) };
    expect(claudeAvailability(c, NOW)).toEqual({ available: true, reason: null });
  });
  it('missing claude observation → available (today’s behaviour)', () => {
    expect(claudeAvailability(null, NOW)).toEqual({ available: true, reason: null });
  });
});

describe('T5-T8 fallback routing to the exceptions seat', () => {
  it('T5 end of rotation, Claude unavailable → exafyltd, fallback true', () => {
    const l = lane();
    const d = reassignDecision(l, st([l], UNAVAILABLE), NOW);
    expect(EXCEPTIONS_SEAT).toBe('exafyltd');
    expect(d).toMatchObject({ kind: 'reassign', to_actor: 'exafyltd', fallback: true });
  });
  it('T6 / M6 end of rotation, Claude available → claude, fallback false', () => {
    const l = lane();
    expect(reassignDecision(l, st([l], AVAILABLE), NOW)).toMatchObject({ to_actor: 'claude', fallback: false });
  });
  it('T7 lane already on exafyltd, Claude unavailable → no self loop (null)', () => {
    const l = lane({ seat: 'exafyltd' });
    const rot: AreaSeatRotation[] = [{ area: 'platform', seats: ['exafyltd'] }];
    expect(reassignDecision(l, { ...st([l], UNAVAILABLE), rotations: rot }, NOW)).toBeNull();
  });
  it('T8 park with Claude unavailable → actPark writes next_actor exafyltd', async () => {
    const l = lane({ state: 'executing', pr: { url: 'https://github.com/exafyltd/vitana-platform/pull/1', title: 'VTID-09001', head_sha: HEAD, checks: [], mergeable: true, merged: false, consecutive_ci_failures: 3 } });
    const d = parkDecision(l, NOW, claudeAvailability(UNAVAILABLE, NOW));
    expect(d).toMatchObject({ kind: 'park', to_actor: 'exafyltd', fallback: true });
    const writes: any[] = [];
    process.env.PM_MODE = 'live';
    await actOnDecisions([d!], st([l]), {
      ...baseDeps([]),
      laneWriter: { write: async (c) => { writes.push(c); return 'written' as const; } },
    });
    expect(writes[0]).toMatchObject({ state: 'parked', next_actor: 'exafyltd' });
  });
  it('M6 park with Claude available → next_actor claude', () => {
    const l = lane({ state: 'executing', pr: { url: 'u', title: 't', head_sha: HEAD, checks: [], mergeable: true, merged: false, consecutive_ci_failures: 3 } });
    expect(parkDecision(l, NOW, claudeAvailability(AVAILABLE, NOW))).toMatchObject({ to_actor: 'claude', fallback: false });
  });
  it('decide() threads the availability into reassign', () => {
    const l = lane();
    const out = decide(st([l], UNAVAILABLE), NOW);
    expect(out).toEqual([expect.objectContaining({ kind: 'reassign', to_actor: 'exafyltd' })]);
  });
});

describe('T13-T15 timers without a live plan driver', () => {
  it('T13 ready 3 h, no driver (null heartbeat) → reassign with window 2 h', () => {
    const l = lane({ state_since: ISO(NOW - 3 * HOUR), driver_heartbeat_at: null });
    const d = reassignDecision(l, st([l], AVAILABLE), NOW);
    expect(d).toMatchObject({ kind: 'reassign', reason: 'stale_ready', window_ms: REASSIGN_NO_DRIVER_AFTER_MS });
    expect(REASSIGN_NO_DRIVER_AFTER_MS).toBe(2 * HOUR);
  });
  it('T14 guard: ready 3 h, heartbeat 1 min ago → no reassign', () => {
    const l = lane({ state_since: ISO(NOW - 3 * HOUR), driver_heartbeat_at: ISO(NOW - 60_000) });
    expect(reassignDecision(l, st([l], AVAILABLE), NOW)).toBeNull();
  });
  it('T14b a heartbeat older than 45 min counts as no driver', () => {
    const l = lane({ state_since: ISO(NOW - 3 * HOUR), driver_heartbeat_at: ISO(NOW - 50 * 60_000) });
    expect(reassignDecision(l, st([l], AVAILABLE), NOW)).toMatchObject({ window_ms: 2 * HOUR });
  });
  it('T15 claim 5 h, no activity, no driver → park stale_claim, window 4 h', () => {
    const l = lane({ state: 'executing', claimed_at: ISO(NOW - 5 * HOUR), driver_heartbeat_at: null });
    expect(parkDecision(l, NOW)).toMatchObject({ kind: 'park', reason: 'stale_claim', window_ms: 4 * HOUR, release_claim: true });
  });
  it('T15b claim 5 h with a live driver → no park (48 h window)', () => {
    const l = lane({ state: 'executing', claimed_at: ISO(NOW - 5 * HOUR), driver_heartbeat_at: ISO(NOW - 60_000) });
    expect(parkDecision(l, NOW)).toBeNull();
  });
  it('cap 6: no reassign of a ready lane into a plan with 6 lanes executing|in-review', () => {
    const busy = Array.from({ length: 6 }, (_, i) => lane({ lane: `b${i}`, state: i % 2 ? 'executing' : 'in-review', reviews: [], state_since: ISO(NOW - HOUR) }));
    const ready = lane({ lane: 'r', state_since: ISO(NOW - 30 * HOUR) });
    const s = st([...busy, ready], AVAILABLE);
    expect(buildLanesInFlight(s)).toEqual({ demo: 6 });
    expect(reassignDecision(ready, s, NOW)).toBeNull();
  });
});

function greenPr(n: number, o: Record<string, unknown> = {}) {
  return {
    url: `https://github.com/exafyltd/vitana-platform/pull/${n}`,
    title: `VTID-0900${n} x`,
    head_sha: HEAD,
    checks: [
      { name: 'Lane scope', conclusion: 'success' as const, head_sha: HEAD },
      { name: 'Collab handoff', conclusion: 'success' as const, head_sha: HEAD },
    ],
    mergeable: true,
    merged: false,
    consecutive_ci_failures: 0,
    files: ['services/gateway/src/services/demo/x.ts'],
    review_only_since: [],
    behind_by: 0,
    ...o,
  };
}
function verifiedLane(n: number, sinceH: number, o: Partial<ObservedLane> = {}): ObservedLane {
  return lane({
    lane: `v${n}`,
    vtid: `VTID-0900${n}`,
    state: 'verified',
    state_since: ISO(NOW - sinceH * HOUR),
    pr: greenPr(n),
    reviews: [{ session_id: 'agent-vitana-lane-reviewer-202610201100-0001', reviewer_seat: 'jtadic', verdict: 'accept', head_sha: HEAD, at: ISO(NOW - HOUR), reviewer: 'agent:vitana-lane-reviewer (claude-sonnet-5.5)' }],
    ...o,
  });
}

describe('T16-T17 merge queue', () => {
  it('T16 two eligible lanes in one repo → exactly one merge (oldest state_since)', () => {
    const a = verifiedLane(1, 1);
    const b = verifiedLane(2, 3);
    const merges = decide(st([a, b], AVAILABLE), NOW).filter((d) => d.kind === 'merge');
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ lane: 'v2' });
  });
  it('T16b one merge per repo: lanes in different repos both merge', () => {
    const a = verifiedLane(1, 1);
    const b = verifiedLane(2, 3, { pr: greenPr(2, { url: 'https://github.com/exafyltd/vitana-v1/pull/2' }) });
    expect(decide(st([a, b], AVAILABLE), NOW).filter((d) => d.kind === 'merge')).toHaveLength(2);
  });
  it('T17 behind main → update_branch, no merge', () => {
    const a = verifiedLane(1, 1, { pr: greenPr(1, { behind_by: 3 }) });
    const out = decide(st([a], AVAILABLE), NOW);
    expect(out.map((d) => d.kind)).toEqual(['update_branch']);
    expect(out[0]).toMatchObject({ head_sha: HEAD, behind_by: 3 });
  });
  it('verify (W1): in-review lane with an agent accept on the current head → verify', () => {
    const a = verifiedLane(1, 1, { state: 'in-review' });
    expect(decide(st([a], AVAILABLE), NOW).map((d) => d.kind)).toEqual(['verify']);
  });
});

function planPr(o: Partial<ObservedPlanPr> = {}): ObservedPlanPr {
  return {
    slug: 'demo',
    url: 'https://github.com/exafyltd/vitana-platform/pull/77',
    title: 'plan(demo): a plan',
    head_sha: HEAD,
    head_commit_session: 'ci-plan-spar',
    files: ['.kiro/specs/demo/plan.md', '.kiro/specs/demo/handoff.md', '.kiro/specs/demo/lanes/l1.md'],
    checks: [
      { name: 'PLAN-SPAR', conclusion: 'success', head_sha: HEAD },
      { name: 'validate', conclusion: 'success', head_sha: HEAD },
    ],
    mergeable: true,
    merged: false,
    behind_by: 0,
    handoff_state: 'approved',
    vtids: ['VTID-09100'],
    head_plan_hash: 'f'.repeat(64),
    sparring: { session_id: 's1', producer: 'ci-plan-spar.demo', verdict: 'converged', policy_approved_at: ISO(NOW - HOUR), final_plan_hash: 'f'.repeat(64) },
    ...o,
  };
}

describe('T18 merge_plan', () => {
  it('spec-only, converged, policy-approved plan( PR → merge_plan', () => {
    expect(planMergeDecision(planPr())).toMatchObject({ kind: 'merge_plan', vtid: 'VTID-09100', head_sha: HEAD });
  });
  it.each([
    ['a file outside the spec', { files: ['.kiro/specs/demo/plan.md', 'scripts/x.mjs'] }],
    ['plan hash mismatch', { head_plan_hash: 'e'.repeat(64) }],
    ['head commit not PLAN-SPAR', { head_commit_session: 'kiro-exafy-202610201807-2a87' }],
    ['not converged', { sparring: { session_id: 's1', producer: 'ci-plan-spar.demo', verdict: 'escalated', policy_approved_at: null, final_plan_hash: 'f'.repeat(64) } }],
    ['no policy approval', { sparring: { session_id: 's1', producer: 'ci-plan-spar.demo', verdict: 'converged', policy_approved_at: null, final_plan_hash: 'f'.repeat(64) } }],
    ['handoff not approved', { handoff_state: 'drafted' }],
    ['no VTIDs', { vtids: [] }],
    ['a red check', { checks: [{ name: 'validate', conclusion: 'failure' as const, head_sha: HEAD }] }],
    ['not mergeable', { mergeable: false }],
    ['title of another slug', { title: 'plan(other): x' }],
  ])('none for %s', (_n, o) => {
    expect(planMergeDecision(planPr(o as Partial<ObservedPlanPr>))).toBeNull();
  });
  it('decide() emits merge_plan when no lane merge took the repo this tick', () => {
    expect(decide(st([], AVAILABLE, { plan_prs: [planPr()] }), NOW).map((d) => d.kind)).toEqual(['merge_plan']);
  });
  it('W2 bookkeeping PR (pm-agent only, spec + timings) → merge_bookkeeping', () => {
    const b: ObservedBookkeepingPr = {
      slug: 'demo', url: 'https://github.com/exafyltd/vitana-platform/pull/78',
      title: 'VTID-09100 (demo/_plan): PM bookkeeping', head_sha: HEAD,
      files: ['.kiro/specs/demo/lanes/l1.md', 'docs/validation/VTID-09100/timings.json'],
      checks: [{ name: 'validate', conclusion: 'success', head_sha: HEAD }],
      mergeable: true, merged: false, behind_by: 0, commit_sessions: ['pm-agent'],
    };
    expect(bookkeepingMergeDecision(b)).toMatchObject({ kind: 'merge_bookkeeping', vtid: 'VTID-09100' });
    expect(bookkeepingMergeDecision({ ...b, commit_sessions: ['pm-agent', 'kiro-exafy-202610201807-2a87'] })).toBeNull();
    expect(bookkeepingMergeDecision({ ...b, files: ['services/gateway/src/index.ts'] })).toBeNull();
  });
});

describe('T19 Gate 2', () => {
  const dep = (o: Partial<ObservedLane>) => lane({ state: 'done', deploys: true, ...o });
  it('one lane verified 5 h ago, the sibling parked → all_verified', () => {
    const a = dep({ lane: 'a', vtid: 'VTID-09001', staging_verified: true, staging_verified_at: ISO(NOW - 5 * HOUR) });
    const b = dep({ lane: 'b', vtid: 'VTID-09002', state: 'parked' });
    expect(gate2Decisions(st([a, b]), NOW)).toEqual([{ kind: 'gate2', slug: 'demo', vtids: ['VTID-09001'], reason: 'all_verified' }]);
  });
  it('gate2_sent per lane: a lane already sent is not re-sent, a newly verified sibling is', () => {
    const a = dep({ lane: 'a', vtid: 'VTID-09001', staging_verified: true, staging_verified_at: ISO(NOW - 6 * HOUR), gate2_sent: true });
    const b = dep({ lane: 'b', vtid: 'VTID-09002', staging_verified: true, staging_verified_at: ISO(NOW - HOUR) });
    expect(gate2Decisions(st([a, b]), NOW)).toEqual([{ kind: 'gate2', slug: 'demo', vtids: ['VTID-09002'], reason: 'all_verified' }]);
  });
});

describe('T20 tick default', () => {
  it('pmTickIntervalMs default 120000; lease TTL = tick − 30 s', () => {
    expect(pmTickIntervalMs({} as NodeJS.ProcessEnv)).toBe(120000);
    expect(pmLeaseTtlMs({} as NodeJS.ProcessEnv)).toBe(90000);
  });
});

describe('T22 ledger decision', () => {
  it('executing lane with ledger row scheduled → one ledger decision; in_progress → none', () => {
    const l = lane({ state: 'executing', ledger_status: 'scheduled', state_since: ISO(NOW - HOUR) });
    expect(ledgerDecision(l)).toEqual({ kind: 'ledger', slug: 'demo', lane: 'l1', vtid: 'VTID-09001', set: { status: 'in_progress', spec_status: 'approved' } });
    expect(decide(st([l], AVAILABLE), NOW).filter((d) => d.kind === 'ledger')).toHaveLength(1);
    expect(ledgerDecision({ ...l, ledger_status: 'in_progress' })).toBeNull();
    expect(ledgerDecision({ ...l, state: 'ready' })).toBeNull();
  });
});

const prevMode = process.env.PM_MODE;
afterEach(() => {
  if (prevMode === undefined) delete process.env.PM_MODE;
  else process.env.PM_MODE = prevMode;
});

class Lease implements LeaseManager {
  async acquire(holder: string): Promise<LeaseOutcome> {
    return { acquired: true, holder, expires_at: ISO(NOW + 60_000) };
  }
}
function baseDeps(calls: SafeMergeRequest[]): ActDeps {
  return {
    safeMerge: async (i) => {
      calls.push(i);
      return { result: 'merged', status: 200, body: { ok: true, merged: true, vtid: i.vtid } };
    },
    laneWriter: { write: async () => 'written' as const },
    gate2Poster: { post: async () => undefined },
    gate2Evidence: { resolve: async () => ({ verified_commit: 'v', production_commit: 'p', commits: [] }) },
    lease: new Lease(),
  };
}

describe('M7 new decision kinds never reach deploy / dispatch / allocate', () => {
  it('acting on every new kind uses only safe-merge, update-branch, lane writes and the ledger writer', async () => {
    process.env.PM_MODE = 'live';
    const calls: SafeMergeRequest[] = [];
    const updates: unknown[] = [];
    const ledger: unknown[] = [];
    const writes: any[] = [];
    const decisions: PmDecision[] = [
      { kind: 'verify', slug: 'demo', lane: 'l1', vtid: 'VTID-09001', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/1', head_sha: HEAD },
      { kind: 'update_branch', slug: 'demo', lane: 'l2', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/2', head_sha: HEAD, behind_by: 1 },
      { kind: 'merge_plan', slug: 'demo', vtid: 'VTID-09100', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/77', head_sha: HEAD },
      { kind: 'merge_bookkeeping', slug: 'demo', vtid: 'VTID-09100', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/78', head_sha: HEAD },
      { kind: 'ledger', slug: 'demo', lane: 'l1', vtid: 'VTID-09001', set: { status: 'in_progress', spec_status: 'approved' } },
    ];
    const res = await actOnDecisions(decisions, st([]), {
      ...baseDeps(calls),
      laneWriter: { write: async (c) => { writes.push(c); return 'written' as const; } },
      updateBranch: async (repo, n, sha) => { updates.push({ repo, n, sha }); return { ok: true, status: 202 }; },
      ledgerWriter: { patch: async (vtid, set) => { ledger.push({ vtid, set }); return { ok: true }; } },
    });
    expect(res.results.map((r) => r.status)).toEqual(['verified_written', 'branch_updated', 'plan_merged', 'plan_merged', 'ledger_updated']);
    expect(calls.map((c) => c.pr_number)).toEqual([77, 78]);
    expect(updates).toEqual([{ repo: 'exafyltd/vitana-platform', n: 2, sha: HEAD }]);
    expect(ledger).toEqual([{ vtid: 'VTID-09001', set: { status: 'in_progress', spec_status: 'approved' } }]);
    expect(writes[0]).toMatchObject({ slug: 'demo', lane: 'l1', state: 'verified', target: 'pr_branch' });
  });

  it('no project-manager source file reaches a deploy, dispatch or VTID allocation path', () => {
    const dir = join(__dirname, '..', '..', 'src', 'services', 'project-manager');
    const forbidden = [/\/dispatches\b/, /workflow_dispatch/, /allocate_global_vtid/, /\/vtid\/allocate/, /AWS-PROD-DEPLOY/, /publish-to-prod/, /actions\/workflows\/[^'"`]*\/runs/];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'governance.ts')) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const re of forbidden) expect({ file: f, hit: re.test(text) }).toEqual({ file: f, hit: false });
    }
  });
});
