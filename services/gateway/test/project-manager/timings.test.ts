/**
 * VTID-05274 — plan timings (plan kiro-autonomy-fallback §4.6, T21) and the
 * Gate 2 evidence + Operator Chat message (§5 C5, T23).
 */
import { planTimings, type PlanTimingsInput } from '../../src/services/project-manager/timings';
import {
  OperatorChatGate2Poster,
  RunViewGate2EvidenceResolver,
  renderGate2Message,
  type Gate2SourceDeps,
  type Gate2Store,
} from '../../src/services/project-manager/gate2';
import { GATE2_QUESTION, type ObservedState } from '../../src/services/project-manager/types';

const T = (s: string) => `2026-10-20T${s}:00.000Z`;

function input(o: Partial<PlanTimingsInput> = {}): PlanTimingsInput {
  return {
    plan_slug: 'kiro-autonomy-fallback',
    vtid: 'VTID-05271',
    vtids: ['VTID-05271', 'VTID-05274'],
    generated_by: 'pm-agent',
    plan_pr_opened_at: T('17:30'),
    converged_at: T('17:47'),
    policy_approved_at: T('17:48'),
    vtids_allocated_at: T('17:49'),
    plan_merged_at: T('18:11'),
    gate2_sent_at: null,
    lanes: [
      { lane: 'a', vtid: 'VTID-05271', claimed_at: T('18:20'), pr_opened_at: T('18:50'), accepted_at: T('19:00'), merged_at: T('19:10'), staging_verified_at: T('19:40'), review_rounds: 1, ci_fix_attempts: 0 },
      { lane: 'b', vtid: 'VTID-05274', claimed_at: T('19:15'), pr_opened_at: null, accepted_at: null, merged_at: T('20:00'), staging_verified_at: T('20:30'), review_rounds: 0, ci_fix_attempts: 2 },
    ],
    merge_conflict_count: 1,
    staging_verify_failure_count: 0,
    ...o,
  };
}

const MIN = 60_000;

describe('T21 planTimings', () => {
  it('computes every duration exactly', () => {
    const t = planTimings(input(), T('21:00'));
    expect(t).toMatchObject({
      schema: 'vitana.plan-timings/v1',
      plan_slug: 'kiro-autonomy-fallback',
      vtid: 'VTID-05271',
      generated_at: T('21:00'),
      generated_by: 'pm-agent',
      convergence_ms: 17 * MIN,
      vtid_ms: 1 * MIN,
      plan_merge_ms: 23 * MIN,
      staging_verify_ms: 30 * MIN,
      approved_to_verified_ms: (2 * 60 + 42) * MIN,
      merge_conflict_count: 1,
      staging_verify_failure_count: 0,
    });
    expect(t.lanes[0]).toMatchObject({ lane: 'a', build_ms: 30 * MIN, review_ms: 10 * MIN, merge_ms: 10 * MIN, review_rounds: 1 });
  });

  it('a missing source → null (never 0) and named in sources_unavailable', () => {
    const t = planTimings(input({ converged_at: null, merge_conflict_count: null }), T('21:00'));
    expect(t.convergence_ms).toBeNull();
    expect(t.lanes[1]).toMatchObject({ build_ms: null, review_ms: null, merge_ms: null, ci_fix_attempts: 2 });
    expect(t.sources_unavailable).toEqual(expect.arrayContaining(['converged_at', 'merge_conflict_count', 'lanes.b.pr_opened_at', 'lanes.b.accepted_at']));
    expect(t.merge_conflict_count).toBe(0);
  });
});

function sources(o: Partial<Gate2SourceDeps> = {}): Gate2SourceDeps {
  return {
    productionCommit: async (s) => (s === 'gateway' ? 'p'.repeat(40) : null),
    verifyEvents: async () => [
      {
        topic: 'staging.verify.passed', created_at: T('20:30'), service: 'gateway', commit: 'v'.repeat(40),
        production_commit: 'p'.repeat(40), run_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/1',
        vtids: ['VTID-05274'], results: [{ ok: true }, { ok: true }, { ok: false }],
      },
    ],
    commitsBetween: async () => [{ sha: 'c1', message: 'one' }, { sha: 'c2', message: 'two' }],
    changedFiles: async () => ['supabase/migrations/20261020000000_x.sql', 'services/gateway/src/index.ts'],
    ...o,
  };
}

const state = (): ObservedState => ({
  mode: 'live',
  rotations: [],
  lanes: [{
    slug: 'kiro-autonomy-fallback', lane: 'pm-fallback', vtid: 'VTID-05274', state: 'done', seat: 'exafy', reviewer_seat: 'exafyltd',
    area: 'platform', paths: ['services/gateway/**'], depends_on: [], pr: null, reviews: [], executing_log: [],
    state_since: T('20:00'), last_branch_activity: null, claimed_at: T('19:15'), seat_ran_automation_in_window: true,
    staging_verified: true, deploys: true, staging_verified_at: T('20:30'), gate2_sent: false,
    decisions_taken: ['kept pmMode() default dry_run'],
  }],
});

describe('T23 Gate 2 evidence and message', () => {
  it('evidence carries services, staging_verify, migrations, decisions_taken, timings, unavailable', async () => {
    const r = new RunViewGate2EvidenceResolver(sources());
    const e = await r.resolve({ kind: 'gate2', slug: 'kiro-autonomy-fallback', vtids: ['VTID-05274'], reason: 'all_verified' }, state());
    expect(e.verified_commit).toBe('v'.repeat(40));
    expect(e.production_commit).toBe('p'.repeat(40));
    expect(e.commits).toEqual(['c1', 'c2']);
    expect(e.services).toEqual([{ service: 'gateway', repo: 'exafyltd/vitana-platform', verified_commit: 'v'.repeat(40), production_commit: 'p'.repeat(40) }]);
    expect(e.staging_verify).toEqual([{ service: 'gateway', run_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/1', passed: 2, failed: 1, total: 3 }]);
    expect(e.migrations).toEqual(['supabase/migrations/20261020000000_x.sql']);
    expect(e.decisions_taken).toEqual(['pm-fallback: kept pmMode() default dry_run']);
    expect(e.timings).toMatchObject({ schema: 'vitana.plan-timings/v1', plan_slug: 'kiro-autonomy-fallback' });
    expect(Array.isArray(e.unavailable)).toBe(true);
  });

  it('a failing source fails open into unavailable[]', async () => {
    const r = new RunViewGate2EvidenceResolver(sources({ productionCommit: async () => { throw new Error('down'); } }));
    const e = await r.resolve({ kind: 'gate2', slug: 'kiro-autonomy-fallback', vtids: ['VTID-05274'], reason: 'all_verified' }, state());
    expect(e.unavailable).toEqual(expect.arrayContaining(['production_commit:gateway']));
  });

  it('the poster writes one assistant message with the question and a pm_digests gate2 row; never deploys', async () => {
    const calls: string[] = [];
    const store: Gate2Store = {
      threadForVtids: async () => null,
      ensureThread: async (id) => { calls.push(`thread:${id}`); },
      insertMessage: async (id, content) => { calls.push(`msg:${id}:${content.includes(GATE2_QUESTION)}`); },
      insertDigest: async (p) => { calls.push(`digest:${(p as any).vtids.join(',')}`); },
    };
    const r = new RunViewGate2EvidenceResolver(sources());
    const decision = { kind: 'gate2' as const, slug: 'kiro-autonomy-fallback', vtids: ['VTID-05274'], reason: 'all_verified' as const };
    const evidence = await r.resolve(decision, state());
    await new OperatorChatGate2Poster(store).post({ slug: decision.slug, vtids: decision.vtids, question: GATE2_QUESTION, evidence });
    expect(calls).toEqual(['thread:pm-gate2-kiro-autonomy-fallback', 'msg:pm-gate2-kiro-autonomy-fallback:true', 'digest:VTID-05274']);
    const text = renderGate2Message({ slug: decision.slug, vtids: decision.vtids, question: GATE2_QUESTION, evidence });
    expect(text).toContain(GATE2_QUESTION);
    expect(text).toContain('https://github.com/exafyltd/vitana-platform/actions/runs/1');
    expect(text).toContain('supabase/migrations/20261020000000_x.sql');
    expect(text).toContain('kept pmMode() default dry_run');
    expect(text).toContain('c1');
  });
});
