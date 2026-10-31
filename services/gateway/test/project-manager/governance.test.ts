/**
 * VTID-05274 — the PM governance guard (plan kiro-autonomy-fallback §4.1, §4.3, §5 C1).
 *
 * T9-T12 (merge on the reviewer agent's accept), T25 (parity with
 * scripts/collab/protected-gate-files.json) and the mutations M1-M5.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PROTECTED_GATE_GLOBS,
  REVIEWER_AGENT,
  REVIEWER_AGENT_MODELS,
  governanceMergeAllowed,
  isAgentReview,
  reviewOnCurrentHead,
  reviewSatisfiesLane,
  touchesProtectedGate,
} from '../../src/services/project-manager/governance';
import { decide, mergeDecision } from '../../src/services/project-manager/decide';
import { actOnDecisions, type ActDeps } from '../../src/services/project-manager/act';
import type { LeaseManager, LeaseOutcome } from '../../src/services/project-manager/lease';
import type { SafeMergeRequest } from '../../src/types/cicd';
import type {
  MergeDecision,
  ObservedLane,
  ObservedPr,
  ObservedState,
  ReviewEntry,
} from '../../src/services/project-manager/types';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const ISO = (ms: number) => new Date(ms).toISOString();
const HOUR = 3600_000;
const HEAD = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const AGENT = `${REVIEWER_AGENT} (claude-sonnet-5.5)`;

function pr(o: Partial<ObservedPr> = {}): ObservedPr {
  return {
    url: 'https://github.com/exafyltd/vitana-platform/pull/5000',
    title: 'VTID-05276 (kiro-autonomy-fallback/scope-check): x',
    head_sha: HEAD,
    checks: [
      { name: 'Lane scope', conclusion: 'success', head_sha: HEAD },
      { name: 'Collab handoff', conclusion: 'success', head_sha: HEAD },
    ],
    mergeable: true,
    merged: false,
    consecutive_ci_failures: 0,
    review_only_since: [],
    files: ['scripts/collab/plan-driver.mjs'],
    behind_by: 0,
    ...o,
  };
}

function agentAccept(o: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    session_id: 'agent-vitana-lane-reviewer-202610201200-abcd',
    reviewer_seat: 'exafyltd',
    verdict: 'accept',
    head_sha: HEAD,
    at: ISO(NOW - HOUR),
    reviewer: AGENT,
    ...o,
  };
}

function lane(o: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'kiro-autonomy-fallback',
    lane: 'scope-check',
    vtid: 'VTID-05276',
    state: 'verified',
    seat: 'exafy',
    reviewer_seat: 'exafyltd',
    area: 'platform',
    paths: ['scripts/collab/plan-driver.mjs'],
    depends_on: [],
    pr: pr(),
    reviews: [agentAccept()],
    executing_log: [{ session_id: 'kiro-exafy-202610201807-2a87', seat: 'exafy', at: ISO(NOW - 5 * HOUR) }],
    state_since: ISO(NOW - HOUR),
    last_branch_activity: ISO(NOW - HOUR),
    claimed_at: ISO(NOW - 5 * HOUR),
    seat_ran_automation_in_window: true,
    staging_verified: false,
    deploys: false,
    staging_verified_at: null,
    gate2_sent: false,
    ...o,
  };
}

const state = (lanes: ObservedLane[]): ObservedState => ({ mode: 'live', lanes, rotations: [] });

class Lease implements LeaseManager {
  async acquire(holder: string): Promise<LeaseOutcome> {
    return { acquired: true, holder, expires_at: ISO(NOW + 60_000) };
  }
}

function deps(calls: SafeMergeRequest[]): ActDeps {
  return {
    safeMerge: async (i) => {
      calls.push(i);
      return { result: 'merged', status: 200, body: { ok: true, merged: true, vtid: i.vtid, details: { head: HEAD } } };
    },
    laneWriter: { write: async () => 'written' as const },
    gate2Poster: { post: async () => undefined },
    gate2Evidence: { resolve: async () => ({ verified_commit: 'v', production_commit: 'p', commits: [] }) },
    lease: new Lease(),
  };
}

const mergeOf = (l: ObservedLane): MergeDecision => ({
  kind: 'merge', slug: l.slug, lane: l.lane, vtid: l.vtid as string, pr_url: l.pr!.url, head_sha: l.pr!.head_sha,
});

const prevMode = process.env.PM_MODE;
afterEach(() => {
  if (prevMode === undefined) delete process.env.PM_MODE;
  else process.env.PM_MODE = prevMode;
});

describe('T9-T12 merge on the reviewer agent accept', () => {
  it('T9 governance lane + agent accept on the current head + checks green → merge decision and act merges', async () => {
    const l = lane();
    expect(mergeDecision(l, [l])).toMatchObject({ kind: 'merge', vtid: 'VTID-05276' });
    process.env.PM_MODE = 'live';
    const calls: SafeMergeRequest[] = [];
    const res = await actOnDecisions([mergeOf(l)], state([l]), deps(calls));
    expect(res.results[0].status).toBe('merged');
    expect(calls).toHaveLength(1);
  });

  it('T10 non-governance lane, reviewer_seat differs from the review seat, agent accept → merge', () => {
    const l = lane({
      paths: ['services/gateway/src/services/project-manager/**'],
      reviewer_seat: 'jtadic',
      pr: pr({ files: ['services/gateway/src/services/project-manager/decide.ts'] }),
    });
    expect(mergeDecision(l, [l])).not.toBeNull();
  });

  it('T11 agent accept on H, review-only commits after it (review_only_since [H]) → merge', () => {
    const l = lane({ pr: pr({ review_only_since: [OLD] }), reviews: [agentAccept({ head_sha: OLD })] });
    expect(mergeDecision(l, [l])).not.toBeNull();
  });

  it('T12 guard: a legacy claude review on a governance lane still merges', async () => {
    const l = lane({
      reviewer_seat: 'claude',
      reviews: [{ session_id: 'session_abc', reviewer_seat: 'claude', verdict: 'approve', head_sha: HEAD, at: ISO(NOW) }],
    });
    expect(mergeDecision(l, [l])).not.toBeNull();
    process.env.PM_MODE = 'live';
    const calls: SafeMergeRequest[] = [];
    const res = await actOnDecisions([mergeOf(l)], state([l]), deps(calls));
    expect(res.results[0].status).toBe('merged');
  });
});

describe('M1 protected gate files never merge on an agent accept alone', () => {
  it.each([...PROTECTED_GATE_GLOBS])('%s', async (glob) => {
    const file = glob.replace(/\*\*/g, 'x/y.ts').replace(/\*/g, 'x');
    const l = lane({ pr: pr({ files: [file] }) });
    expect(touchesProtectedGate([file])).toBe(true);
    expect(governanceMergeAllowed(l, l.pr, agentAccept())).toEqual({ ok: false, reason: 'protected_gate_file' });
    expect(mergeDecision(l, [l])).toBeNull();
    process.env.PM_MODE = 'live';
    const calls: SafeMergeRequest[] = [];
    const res = await actOnDecisions([mergeOf(l)], state([l]), deps(calls));
    expect(res.results[0].status).toBe('governance_blocked');
    expect(res.results[0].detail).toMatch(/protected_gate_file/);
    expect(calls).toHaveLength(0);
  });

  it('VTID-05408: a legacy claude review no longer unlocks a protected file (the unlock is retired, not transferred)', () => {
    const l = lane({ reviewer_seat: 'claude', pr: pr({ files: ['CLAUDE.md'] }) });
    const r: ReviewEntry = { session_id: 'session_x', reviewer_seat: 'claude', verdict: 'approve', head_sha: HEAD, at: ISO(NOW) };
    expect(governanceMergeAllowed(l, l.pr, r)).toEqual({ ok: false, reason: 'protected_gate_file' });
    expect(mergeDecision(l, [l])).toBeNull();
  });

  it('VTID-05408: a protected file is refused with NO review supplied too (defense-in-depth, always refuse)', () => {
    const l = lane({ pr: pr({ files: ['scripts/collab/queue.mjs'] }) });
    expect(governanceMergeAllowed(l, l.pr, null)).toEqual({ ok: false, reason: 'protected_gate_file' });
  });

  it('the compiled-in list is never empty', () => {
    expect(PROTECTED_GATE_GLOBS.length).toBeGreaterThanOrEqual(12);
  });
});

describe('M2-M5 reviews that do not count', () => {
  it('M2 stale head: accept on an old head with no review-only commits → no merge', () => {
    const l = lane({ pr: pr({ review_only_since: [] }), reviews: [agentAccept({ head_sha: OLD })] });
    expect(reviewOnCurrentHead(l.reviews[0], l.pr!)).toBe(false);
    expect(mergeDecision(l, [l])).toBeNull();
    expect(governanceMergeAllowed(l, l.pr, l.reviews[0])).toEqual({ ok: false, reason: 'stale_head' });
  });

  it('M2 review_only_since does not match a different earlier head', () => {
    const l = lane({ pr: pr({ review_only_since: ['c'.repeat(40)] }), reviews: [agentAccept({ head_sha: OLD })] });
    expect(mergeDecision(l, [l])).toBeNull();
  });

  it.each([
    ['agent:someone-else'],
    [null],
    ['agent:vitana-lane-reviewer-fake'],
    ['agent:vitana-lane-reviewer (gpt-5)'],
  ])('M3 reviewer %p → no merge on a governance lane', (reviewer) => {
    const r = agentAccept({ reviewer: reviewer as string | null });
    const l = lane({ reviews: [r] });
    expect(isAgentReview(r)).toBe(false);
    expect(reviewSatisfiesLane(l, r)).toBe(false);
    expect(mergeDecision(l, [l])).toBeNull();
  });

  it('the reviewer model chain is sonnet-5.5 → opus-5.5 → sonnet-4.5 (Claude only)', () => {
    expect(REVIEWER_AGENT_MODELS).toEqual(['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-4.5']);
    expect(REVIEWER_AGENT_MODELS.every((m) => m.startsWith('claude-'))).toBe(true);
  });

  it.each([[REVIEWER_AGENT], ...REVIEWER_AGENT_MODELS.map((m) => [`${REVIEWER_AGENT} (${m})`])])(
    'fallback: reviewer %p on the current head → merge on a governance lane',
    (reviewer) => {
      const r = agentAccept({ reviewer });
      const l = lane({ reviews: [r] });
      expect(isAgentReview(r)).toBe(true);
      expect(reviewSatisfiesLane(l, r)).toBe(true);
      expect(mergeDecision(l, [l])).not.toBeNull();
    },
  );

  it.each([
    ['agent:vitana-lane-reviewer (claude-opus-4.8)'],
    ['agent:vitana-lane-reviewer (claude-sonnet-5)'],
    ['agent:vitana-lane-reviewer (claude-opus-5)'],
    ['agent:vitana-lane-reviewer (claude-haiku-4.5)'],
    ['agent:vitana-lane-reviewer (auto)'],
    ['agent:vitana-lane-reviewer (unstated)'],
    ['agent:vitana-lane-reviewer (gemini-2.5-pro)'],
    ['agent:vitana-lane-reviewer (claude-opus-5.5'],
    ['agent:vitana-lane-reviewer (claude-opus-5.5) x'],
  ])('fallback: reviewer %p (model outside the chain) → no merge', (reviewer) => {
    const r = agentAccept({ reviewer });
    const l = lane({ reviews: [r] });
    expect(isAgentReview(r)).toBe(false);
    expect(mergeDecision(l, [l])).toBeNull();
  });

  it('M4 agent changes on the current head → no merge', () => {
    const l = lane({ reviews: [agentAccept({ verdict: 'changes' })] });
    expect(mergeDecision(l, [l])).toBeNull();
  });

  it('M5 agent review from a session in the executing log → no merge', () => {
    const l = lane({ reviews: [agentAccept({ session_id: 'kiro-exafy-202610201807-2a87' })] });
    expect(mergeDecision(l, [l])).toBeNull();
  });

  it('decide() emits no merge for a protected-file PR with an agent accept', () => {
    const l = lane({ pr: pr({ files: ['scripts/collab/queue.mjs'] }) });
    expect(decide(state([l]), NOW).filter((d) => d.kind === 'merge')).toHaveLength(0);
  });
});

describe('T25 parity with scripts/collab/protected-gate-files.json', () => {
  it('PROTECTED_GATE_GLOBS equals the JSON globs (absent file fails)', () => {
    const p = join(__dirname, '..', '..', '..', '..', 'scripts', 'collab', 'protected-gate-files.json');
    const json = JSON.parse(readFileSync(p, 'utf8')) as { globs: string[] };
    expect(Array.isArray(json.globs)).toBe(true);
    expect([...PROTECTED_GATE_GLOBS].sort()).toEqual([...json.globs].sort());
  });
});
