/**
 * VTID-05254 — Plan Sparring: a dead round-1 session (verdict in_progress, no rounds, pass died) is
 * escalated `deadline_exceeded` and re-run on a fresh session instead of being deduplicated forever.
 *
 * Everything external is faked: the repository is an in-memory store mocked at the module seam (same
 * pattern as vtid-04868-plan-sparring-service.test.ts), the partner model is a scripted `callLlm`, and
 * GitHub is a fake `fetch`. The real `escalateDeadRoundOne` guard chain runs against a recording fake
 * `sb`. No database, Bedrock or GitHub call can leave this process.
 */

process.env.NODE_ENV = 'test';

type Row = Record<string, any>;
const NOW = 1_800_000_000_000;
const store: {
  sessions: Map<string, Row>;
  calls: string[];
  nowMs: number;
  insertErrorOnce: boolean;
  escalateErrorOnce: boolean;
  beforeEscalate: ((id: string) => void) | null;
} = { sessions: new Map(), calls: [], nowMs: NOW, insertErrorOnce: false, escalateErrorOnce: false, beforeEscalate: null };
let idSeq = 0;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

jest.mock('../src/services/plan-sparring/plan-sparring-repository', () => {
  const actual = jest.requireActual('../src/services/plan-sparring/plan-sparring-repository');
  return {
    insertSession: async (_sb: unknown, row: Row) => {
      store.calls.push('insertSession');
      if (store.insertErrorOnce) {
        store.insertErrorOnce = false;
        return { data: null, error: { message: 'insert failed' } };
      }
      idSeq += 1;
      const id = `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`;
      const at = new Date(store.nowMs).toISOString();
      const full = { id, ...row, final_plan_hash: null, verdict: 'in_progress', rounds: [], escalation_reasons: [], model_log: [], human_approved_by: null, human_approved_at: null, approval_evidence: null, policy_approved_at: null, vtid: null, created_at: at, updated_at: at };
      store.sessions.set(id, full);
      return { data: clone(full), error: null };
    },
    fetchSession: async (_sb: unknown, id: string) => {
      store.calls.push('fetchSession');
      const s = store.sessions.get(id);
      return { data: s ? clone(s) : null, error: null };
    },
    fetchSessionByPlanHash: async (_sb: unknown, producer: string, hash: string) => {
      store.calls.push('fetchSessionByPlanHash');
      const all = [...store.sessions.values()].filter((s) => s.producer === producer && s.plan_hash === hash);
      return { data: all.length ? clone(all[all.length - 1]) : null, error: null };
    },
    appendRound: async (_sb: unknown, id: string, round: Row, expectedRound: number) => {
      store.calls.push('appendRound');
      const s = store.sessions.get(id)!;
      if (s.verdict !== 'in_progress' || s.rounds.length + 1 !== expectedRound) {
        return { data: null, error: { code: 'PS409', message: `round_conflict: session ${id}` } };
      }
      s.rounds.push(clone(round));
      return { data: { ok: true, round_count: s.rounds.length }, error: null };
    },
    isRoundConflict: (e: any) => Boolean(e) && e.code === 'PS409',
    updateSessionState: async (_sb: unknown, id: string, patch: Row) => {
      store.calls.push('updateSessionState');
      Object.assign(store.sessions.get(id)!, clone(patch), { updated_at: new Date(store.nowMs).toISOString() });
      return { data: null, error: null };
    },
    // Mirrors escalateDeadRoundOne's guards: id, verdict in_progress, updated_at < cutoff, unapproved.
    escalateDeadRoundOne: async (_sb: unknown, id: string, cutoffIso: string) => {
      store.calls.push('escalateDeadRoundOne');
      if (store.escalateErrorOnce) {
        store.escalateErrorOnce = false;
        return { data: null, error: { message: 'update failed' } };
      }
      if (store.beforeEscalate) store.beforeEscalate(id);
      const s = store.sessions.get(id);
      if (!s || s.verdict !== 'in_progress' || !(s.updated_at < cutoffIso) || s.human_approved_by !== null || s.policy_approved_at !== null) {
        return { data: [], error: null };
      }
      Object.assign(s, { verdict: 'escalated', escalation_reasons: ['deadline_exceeded'], updated_at: new Date(store.nowMs).toISOString() });
      return { data: [{ id }], error: null };
    },
    __actualEscalateDeadRoundOne: actual.escalateDeadRoundOne,
  };
});

import { PLAN_BEGIN_MARKER, PLAN_END_MARKER, canonicalPlanHash } from '../src/services/plan-sparring/canonical-hash';
import {
  STALE_AFTER_MS,
  createSparringSession,
  isDeadRoundOne,
  type PlanSparringDeps,
} from '../src/services/plan-sparring/plan-sparring-service';
import { createCodeToolExecutor } from '../src/services/plan-sparring/github-tools';
import type { LLMRouterOpts, LLMRouterResult } from '../src/services/llm-router';
import type { ChangeClass, SparringSession } from '../src/services/plan-sparring/types';

const SHA = 'a'.repeat(40);
const PRODUCER = 'claude-code';
const PLAN = `# Title\n${PLAN_BEGIN_MARKER}\n## Goal\nAdd X to services/gateway/src/index.ts.\n${PLAN_END_MARKER}\n`;
const HASH = (() => {
  const h = canonicalPlanHash(PLAN);
  if (!h.ok) throw new Error('plan fixture has no markers');
  return h.hash;
})();

// ---------------------------------------------------------------------------
// Scripted partner (round 1 that meets the evidence floor)
// ---------------------------------------------------------------------------
type Step = (opts: LLMRouterOpts, prompt: string) => LLMRouterResult;
function ok(partial: Partial<LLMRouterResult>): LLMRouterResult {
  return { ok: true, provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1', fallbackUsed: false, usage: { inputTokens: 100, outputTokens: 50 }, ...partial };
}
const PATHS = ['services/gateway/src/index.ts', 'services/gateway/src/routes/vtid.ts', 'services/gateway/src/services/llm-router.ts'];
const READ3: Step = () =>
  ok({ text: 'Reading.', toolCalls: PATHS.map((p, i) => ({ id: `r${i}`, name: 'read_file', arguments: { repo: 'exafyltd/vitana-platform', path: p } })), stopReason: 'tool_use' });
const ev = (path: string) => [{ repo: 'exafyltd/vitana-platform', path, start_line: 1, end_line: 3 }];
const REVIEW = {
  summary: 'Reviewed.',
  findings: [{ id: 'R1-F1', severity: 'major', claim: 'No test.', evidence: ev(PATHS[0]), suggestion: 'Add one.' }],
  premise_checks: PATHS.map((p) => ({ premise: `${p} exists`, holds: true, evidence: ev(p) })),
  acknowledgements: [],
};
const SUBMIT: Step = () => ok({ toolCalls: [{ id: 'sub', name: 'submit_review', arguments: REVIEW as unknown as Record<string, unknown> }], stopReason: 'tool_use' });

function makeDeps(steps: Step[], nowMs = NOW) {
  const llmCalls: string[] = [];
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ type: 'file', encoding: 'base64', content: Buffer.from('line1\nline2\nline3\n').toString('base64') }),
    text: async () => '',
  });
  const deps: PlanSparringDeps = {
    sb: {} as never,
    callLlm: jest.fn(async (stage, prompt, opts) => {
      llmCalls.push(stage);
      const step = steps.shift();
      if (!step) throw new Error('script exhausted');
      return step(opts, prompt);
    }),
    makeToolExecutor: (refs) => createCodeToolExecutor({ refs, token: 'sparring-token', fetchImpl: fakeFetch as never }),
    hasCodeAccess: () => true,
    emit: jest.fn(async () => ({ ok: true })),
    now: () => nowMs,
  };
  return { deps, llmCalls };
}

const body = (change_class: ChangeClass = 'standard') => ({ plan_text: PLAN, producer: PRODUCER, change_class, base_ref: SHA });

/** Seed a session straight into the store with explicit timestamps. */
function seed(over: Row = {}): Row {
  idSeq += 1;
  const id = `00000000-0000-4000-9000-${String(idSeq).padStart(12, '0')}`;
  const at = new Date(NOW - 2 * STALE_AFTER_MS).toISOString();
  const row = {
    id, plan_id: id, plan_hash: HASH, final_plan_hash: null, producer: PRODUCER, change_class: 'standard', trust_tier: 'gateway', base_ref: SHA,
    verdict: 'in_progress', rounds: [], escalation_reasons: [], model_log: [], human_approved_by: null, human_approved_at: null,
    approval_evidence: null, approval_policy: null, policy_approved_at: null, policy_approval_rule: null, vtid: null,
    created_at: at, updated_at: at, ...over,
  };
  store.sessions.set(id, row);
  return row;
}

const ROUND1 = { round: 1, at: new Date(NOW - 3 * STALE_AFTER_MS).toISOString(), plan_hash: HASH, plan_text: 'x', tool_log: [], repo_refs: {} };

beforeEach(() => {
  store.sessions.clear();
  store.calls = [];
  store.nowMs = NOW;
  store.insertErrorOnce = false;
  store.escalateErrorOnce = false;
  store.beforeEscalate = null;
});

describe('VTID-05254 stale round-1 session dedup', () => {
  it('(a) escalates a stale in_progress session with 0 rounds and re-runs round 1 on a fresh session', async () => {
    const dead = seed();
    const { deps, llmCalls } = makeDeps([READ3, SUBMIT]);
    const r = await createSparringSession(body(), deps);
    expect(r.deduplicated).toBe(false);
    expect(r.session.id).not.toBe(dead.id);
    expect(r.session.rounds).toHaveLength(1);
    expect(r.session.verdict).toBe('in_progress');
    expect(llmCalls.length).toBeGreaterThan(0);
    const old = store.sessions.get(dead.id)!;
    expect(old.verdict).toBe('escalated');
    expect(old.escalation_reasons).toEqual(['deadline_exceeded']);
    expect(old.final_plan_hash).toBeNull();
    expect(store.calls.filter((c) => c === 'insertSession')).toHaveLength(1);
  });

  it('(b) a fresh in_progress session with 0 rounds is still deduped, with no model call', async () => {
    const live = seed({ created_at: new Date(NOW - 60_000).toISOString(), updated_at: new Date(NOW - 60_000).toISOString() });
    const { deps, llmCalls } = makeDeps([]);
    const r = await createSparringSession(body(), deps);
    expect(r).toMatchObject({ deduplicated: true, session: { id: live.id, verdict: 'in_progress' } });
    expect(llmCalls).toHaveLength(0);
    expect(store.calls).not.toContain('escalateDeadRoundOne');
    expect(store.calls).not.toContain('insertSession');
  });

  it('(c) an old in_progress session with round 1 written (waiting on the planner) is still deduped', async () => {
    const waiting = seed({ rounds: [ROUND1] });
    const { deps, llmCalls } = makeDeps([]);
    const r = await createSparringSession(body(), deps);
    expect(r).toMatchObject({ deduplicated: true, session: { id: waiting.id, verdict: 'in_progress' } });
    expect(llmCalls).toHaveLength(0);
    expect(store.calls).not.toContain('escalateDeadRoundOne');
    expect(store.calls).not.toContain('insertSession');
  });

  it('(d) an escalated session with a non-retryable reason is still deduped', async () => {
    const capped = seed({ verdict: 'escalated', escalation_reasons: ['round_cap_reached'], rounds: [ROUND1] });
    const { deps, llmCalls } = makeDeps([]);
    const r = await createSparringSession(body(), deps);
    expect(r).toMatchObject({ deduplicated: true, session: { id: capped.id, verdict: 'escalated' } });
    expect(llmCalls).toHaveLength(0);
    expect(store.calls).not.toContain('insertSession');
  });

  it('(d2) the existing retryable-escalated path is unchanged: re-run without escalating again', async () => {
    const failed = seed({ verdict: 'escalated', escalation_reasons: ['model_unavailable'], rounds: [ROUND1] });
    const { deps } = makeDeps([READ3, SUBMIT]);
    const r = await createSparringSession(body(), deps);
    expect(r.deduplicated).toBe(false);
    expect(r.session.id).not.toBe(failed.id);
    expect(store.calls).not.toContain('escalateDeadRoundOne');
    expect(store.sessions.get(failed.id)!.escalation_reasons).toEqual(['model_unavailable']);
  });

  it('(e) lost race: the guard updates nothing, the re-read row comes back deduplicated, no insert, no model call', async () => {
    const dead = seed();
    // Another request escalates the row between our read and our guarded UPDATE.
    store.beforeEscalate = (id) => Object.assign(store.sessions.get(id)!, { verdict: 'escalated', escalation_reasons: ['deadline_exceeded'], updated_at: new Date(NOW).toISOString() });
    const { deps, llmCalls } = makeDeps([]);
    const r = await createSparringSession(body(), deps);
    expect(r).toMatchObject({ deduplicated: true, session: { id: dead.id, verdict: 'escalated', escalation_reasons: ['deadline_exceeded'] } });
    expect(llmCalls).toHaveLength(0);
    expect(store.calls).not.toContain('insertSession');
    expect(store.calls.filter((c) => c === 'fetchSessionByPlanHash')).toHaveLength(2);
  });

  describe.each<ChangeClass>(['light', 'standard', 'expedited'])('(f) boundary, %s', (cc) => {
    it('STALE_AFTER_MS - 1 ms is deduped', async () => {
      const at = new Date(NOW - STALE_AFTER_MS + 1).toISOString();
      const s = seed({ change_class: cc, created_at: at, updated_at: at });
      const { deps, llmCalls } = makeDeps([]);
      const r = await createSparringSession(body(cc), deps);
      expect(r).toMatchObject({ deduplicated: true, session: { id: s.id } });
      expect(llmCalls).toHaveLength(0);
    });

    it('STALE_AFTER_MS + 1 ms is re-run', async () => {
      const at = new Date(NOW - STALE_AFTER_MS - 1).toISOString();
      const s = seed({ change_class: cc, created_at: at, updated_at: at });
      const { deps } = makeDeps([READ3, SUBMIT]);
      const r = await createSparringSession(body(cc), deps);
      expect(r.deduplicated).toBe(false);
      expect(r.session.id).not.toBe(s.id);
      expect(store.sessions.get(s.id)!.verdict).toBe('escalated');
    });
  });

  it('(g) isDeadRoundOne is false for a missing/unparsable timestamp or an approved session', () => {
    const base = { ...seed() } as unknown as SparringSession;
    expect(isDeadRoundOne(base, NOW)).toBe(true);
    expect(isDeadRoundOne({ ...base, created_at: undefined, updated_at: undefined }, NOW)).toBe(false);
    expect(isDeadRoundOne({ ...base, updated_at: 'not a date' }, NOW)).toBe(false);
    expect(isDeadRoundOne({ ...base, human_approved_by: '11111111-2222-4333-8444-555555555555' }, NOW)).toBe(false);
    expect(isDeadRoundOne({ ...base, policy_approved_at: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(isDeadRoundOne({ ...base, verdict: 'converged' }, NOW)).toBe(false);
    // updated_at wins over created_at when both are set.
    expect(isDeadRoundOne({ ...base, updated_at: new Date(NOW).toISOString() }, NOW)).toBe(false);
    // created_at is the fallback when updated_at is missing.
    expect(isDeadRoundOne({ ...base, updated_at: undefined }, NOW)).toBe(true);
  });

  it('(h) partial failure: escalation succeeds, insert fails → 502; the next create recovers via the retryable branch', async () => {
    const dead = seed();
    store.insertErrorOnce = true;
    const first = makeDeps([]);
    await expect(createSparringSession(body(), first.deps)).rejects.toMatchObject({ status: 502, code: 'store_error' });
    expect(first.llmCalls).toHaveLength(0);
    expect(store.sessions.get(dead.id)).toMatchObject({ verdict: 'escalated', escalation_reasons: ['deadline_exceeded'], final_plan_hash: null });
    expect(store.sessions.size).toBe(1);

    store.calls = [];
    const second = makeDeps([READ3, SUBMIT]);
    const r = await createSparringSession(body(), second.deps);
    expect(r.deduplicated).toBe(false);
    expect(r.session.id).not.toBe(dead.id);
    expect(r.session.rounds).toHaveLength(1);
    expect(store.calls).not.toContain('escalateDeadRoundOne');
  });

  it('(i) a store error from the escalation throws 502 store_error, with no insert and no re-read', async () => {
    seed();
    store.escalateErrorOnce = true;
    const { deps, llmCalls } = makeDeps([]);
    await expect(createSparringSession(body(), deps)).rejects.toMatchObject({ status: 502, code: 'store_error' });
    expect(llmCalls).toHaveLength(0);
    expect(store.calls).not.toContain('insertSession');
    expect(store.calls.filter((c) => c === 'fetchSessionByPlanHash')).toHaveLength(1);
  });
});

describe('VTID-05254 escalateDeadRoundOne (real guard chain)', () => {
  function recordingSb(result: { data: unknown; error: unknown }) {
    const ops: Array<[string, ...unknown[]]> = [];
    const chain: any = {};
    for (const m of ['update', 'eq', 'lt', 'is', 'select']) {
      chain[m] = (...args: unknown[]) => {
        ops.push([m, ...args]);
        return m === 'select' ? Promise.resolve(result) : chain;
      };
    }
    const sb = { from: (t: string) => { ops.push(['from', t]); return chain; } };
    return { sb: sb as never, ops };
  }
  const realEscalate = (jest.requireMock('../src/services/plan-sparring/plan-sparring-repository') as any).__actualEscalateDeadRoundOne;

  it('updates only an unapproved in_progress row older than the cutoff and selects the ids', async () => {
    const cutoff = new Date(NOW - STALE_AFTER_MS).toISOString();
    const { sb, ops } = recordingSb({ data: [{ id: 'abc' }], error: null });
    const r = await realEscalate(sb, 'abc', cutoff);
    expect(r).toEqual({ data: [{ id: 'abc' }], error: null });
    expect(ops[0]).toEqual(['from', 'plan_sparring_sessions']);
    expect(ops[1][0]).toBe('update');
    const patch = ops[1][1] as Row;
    expect(patch).toMatchObject({ verdict: 'escalated', escalation_reasons: ['deadline_exceeded'] });
    expect(typeof patch.updated_at).toBe('string');
    expect(Object.keys(patch).sort()).toEqual(['escalation_reasons', 'updated_at', 'verdict']);
    expect(ops.slice(2)).toEqual([
      ['eq', 'id', 'abc'],
      ['eq', 'verdict', 'in_progress'],
      ['lt', 'updated_at', cutoff],
      ['is', 'human_approved_by', null],
      ['is', 'policy_approved_at', null],
      ['select', 'id'],
    ]);
  });

  it('passes a store error through', async () => {
    const { sb } = recordingSb({ data: null, error: { message: 'boom' } });
    await expect(realEscalate(sb, 'abc', 'x')).resolves.toEqual({ data: null, error: { message: 'boom' } });
  });
});
