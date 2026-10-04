/**
 * VTID-04868 — Plan Sparring Gate service: canonical hash, partner loop,
 * session lifecycle, approval, allocation events, GitHub tools, reconciler.
 *
 * Everything external is faked: the repository is an in-memory store, the
 * partner model is a scripted `callLlm`, GitHub is a fake `fetch`, and the one
 * "real router" scenario mocks the Bedrock SDK client. No database, Bedrock or
 * GitHub call can leave this process.
 */

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// In-memory repository (the contract tables), mocked at the module seam.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
const store: { sessions: Map<string, Row>; ledger: Row[]; config: Row | null; trigger: any; triggerError: any; calls: string[] } = {
  sessions: new Map(),
  ledger: [],
  config: { id: 1, mode: 'log' },
  trigger: { present: true, tgenabled: 'O' },
  triggerError: null,
  calls: [],
};
let idSeq = 0;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

jest.mock('../src/services/plan-sparring/plan-sparring-repository', () => ({
  insertSession: async (_sb: unknown, row: Row) => {
    store.calls.push('insertSession');
    idSeq += 1;
    const id = `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`;
    const full = { id, ...row, final_plan_hash: null, verdict: 'in_progress', rounds: [], escalation_reasons: [], model_log: [], human_approved_by: null, human_approved_at: null, approval_evidence: null, vtid: null, created_at: new Date(1_700_000_000_000 + idSeq).toISOString() };
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
  appendRound: async (_sb: unknown, id: string, round: Row) => {
    store.calls.push('appendRound');
    store.sessions.get(id)!.rounds.push(clone(round));
    return { data: null, error: null };
  },
  updateSessionState: async (_sb: unknown, id: string, patch: Row) => {
    store.calls.push('updateSessionState');
    if ('rounds' in patch) throw new Error('rounds must only grow through appendRound');
    Object.assign(store.sessions.get(id)!, clone(patch));
    return { data: null, error: null };
  },
  recordApproval: async (_sb: unknown, id: string, approval: Row) => {
    store.calls.push('recordApproval');
    const s = store.sessions.get(id)!;
    if (s.human_approved_by) return { data: [], error: null };
    Object.assign(s, clone(approval));
    return { data: [{ id }], error: null };
  },
  fetchConfig: async () => {
    store.calls.push('fetchConfig');
    return { data: store.config ? clone(store.config) : null, error: null };
  },
  fetchLedgerRowsWithoutSparring: async (_sb: unknown, since: string) => {
    store.calls.push('fetchLedgerRowsWithoutSparring');
    return { data: store.ledger.filter((r) => r.created_at >= since && !r.metadata?.sparring_id), error: null };
  },
  fetchTriggerStatus: async () => {
    store.calls.push('fetchTriggerStatus');
    return store.triggerError ? { data: null, error: store.triggerError } : { data: clone(store.trigger), error: null };
  },
}));

// Real-router scenario: mock the Bedrock SDK + telemetry + policy read.
const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => sendMock(...a) })),
  InvokeModelCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));
jest.mock('../src/services/llm-telemetry-service', () => ({
  startLLMCallDetached: jest.fn(() => ({ id: 'ctx' })),
  completeLLMCallDetached: jest.fn(async () => undefined),
  failLLMCallDetached: jest.fn(async () => undefined),
}));
jest.mock('../src/services/llm-routing-policy-service', () => ({
  getActivePolicy: jest.fn(async () => ({
    policy: Object.fromEntries(
      ['planner', 'worker', 'validator', 'operator', 'memory', 'triage'].map((s) => [
        s,
        { primary_provider: 'bedrock', primary_model: 'eu.anthropic.claude-sonnet-4-6', fallback_provider: 'deepseek', fallback_model: 'deepseek-flash' },
      ]),
    ),
  })),
}));

import {
  PLAN_BEGIN_MARKER,
  PLAN_END_MARKER,
  canonicalPlanHash,
  canonicalizePlanBody,
  extractPlanBody,
  sha256Hex,
} from '../src/services/plan-sparring/canonical-hash';
import {
  approveSparringSession,
  createSparringSession,
  emitAllocationSparringEvent,
  getSparringSession,
  submitPlannerRound,
  unresolvedItems,
  SparringError,
  type PlanSparringDeps,
} from '../src/services/plan-sparring/plan-sparring-service';
import { createCodeToolExecutor, PARTNER_CODE_TOOLS } from '../src/services/plan-sparring/github-tools';
import { PARTNER_SYSTEM_PROMPT, SUBMIT_REVIEW_TOOL } from '../src/services/plan-sparring/partner-prompt';
import {
  isReconcilerEnabled,
  newReconcilerState,
  runPlanSparringReconcile,
  startPlanSparringReconciler,
} from '../src/services/plan-sparring/reconciler';
import { callViaRouter, _resetPolicyCacheForTests, type LLMRouterOpts, type LLMRouterResult } from '../src/services/llm-router';
import { parseSparringId } from '../src/routes/vtid';

const SHA = 'a'.repeat(40);
const ADMIN = '11111111-2222-4333-8444-555555555555';
const plan = (body: string) => `# Title\nnotes outside\n${PLAN_BEGIN_MARKER}\n${body}\n${PLAN_END_MARKER}\nresponses outside\n`;
const PLAN_V1 = plan('## Goal\nAdd X to services/gateway/src/index.ts.\n\nUses routes/vtid.ts allocate.');
const PLAN_V2 = plan('## Goal\nAdd X to services/gateway/src/index.ts.\n\nUses routes/vtid.ts allocate.\nAdds a test.');

// ---------------------------------------------------------------------------
// Scripted partner
// ---------------------------------------------------------------------------
type Step = (opts: LLMRouterOpts, prompt: string) => LLMRouterResult;
const THINK = { type: 'thinking', thinking: 'checking premises', signature: 'SIG==' } as const;
const REDACTED = { type: 'redacted_thinking', data: 'ENC' } as const;

function ok(partial: Partial<LLMRouterResult>): LLMRouterResult {
  return { ok: true, provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1', fallbackUsed: false, usage: { inputTokens: 100, outputTokens: 50 }, ...partial };
}
function readCalls(paths: string[], turnTag = 'r'): Step {
  return () =>
    ok({
      text: 'Reading.',
      thinkingBlocks: [THINK, REDACTED],
      toolCalls: paths.map((p, i) => ({ id: `${turnTag}${i}`, name: 'read_file', arguments: { repo: 'exafyltd/vitana-platform', path: p } })),
      stopReason: 'tool_use',
    });
}
const ev = (path: string) => [{ repo: 'exafyltd/vitana-platform', path, start_line: 1, end_line: 3 }];
function review(over: Record<string, unknown> = {}) {
  return {
    summary: 'Reviewed.',
    findings: [{ id: 'R1-F1', severity: 'major', claim: 'No test for route.', evidence: ev('services/gateway/src/index.ts'), suggestion: 'Add one.' }],
    premise_checks: [
      { premise: 'index.ts mounts routers', holds: true, evidence: ev('services/gateway/src/index.ts') },
      { premise: 'vtid.ts has /allocate', holds: true, evidence: ev('services/gateway/src/routes/vtid.ts') },
      { premise: 'llm-router exists', holds: true, evidence: ev('services/gateway/src/services/llm-router.ts') },
    ],
    acknowledgements: [],
    ...over,
  };
}
const submit = (args: unknown, id = 'sub'): Step => () => ok({ toolCalls: [{ id, name: 'submit_review', arguments: args as Record<string, unknown> }], stopReason: 'tool_use' });
const READ3 = readCalls(['services/gateway/src/index.ts', 'services/gateway/src/routes/vtid.ts', 'services/gateway/src/services/llm-router.ts']);

function makeDeps(steps: Step[], over: Partial<PlanSparringDeps> = {}) {
  const llmCalls: Array<{ stage: string; prompt: string; opts: LLMRouterOpts }> = [];
  const ghCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  const emitted: any[] = [];
  const fakeFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    ghCalls.push({ url, headers: init?.headers ?? {} });
    return { ok: true, status: 200, json: async () => ({ type: 'file', encoding: 'base64', content: Buffer.from('line1\nline2\nline3\n').toString('base64') }), text: async () => '' };
  };
  const deps: PlanSparringDeps = {
    sb: {} as never,
    callLlm: jest.fn(async (stage, prompt, opts) => {
      llmCalls.push({ stage, prompt, opts: JSON.parse(JSON.stringify(opts)) });
      const step = steps.shift();
      if (!step) throw new Error('script exhausted');
      return step(opts, prompt);
    }),
    makeToolExecutor: (refs) => createCodeToolExecutor({ refs, token: 'sparring-token', fetchImpl: fakeFetch as never }),
    hasCodeAccess: () => true,
    emit: jest.fn(async (e) => { emitted.push(e); return { ok: true }; }),
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { deps, llmCalls, ghCalls, emitted };
}

function createBody(planText = PLAN_V1, over: Record<string, unknown> = {}) {
  return { plan_text: planText, producer: 'claude-code', change_class: 'standard', base_ref: SHA, ...over };
}

beforeEach(() => {
  store.sessions.clear();
  store.ledger = [];
  store.config = { id: 1, mode: 'log' };
  store.trigger = { present: true, tgenabled: 'O' };
  store.triggerError = null;
  store.calls = [];
});

// ===========================================================================
describe('canonical plan hash (N6)', () => {
  it('hashes only the text between the markers', () => {
    const a = canonicalPlanHash(`intro A\n${PLAN_BEGIN_MARKER}\nbody\n${PLAN_END_MARKER}\nresponse A`);
    const b = canonicalPlanHash(`intro B\n${PLAN_BEGIN_MARKER}\nbody\n${PLAN_END_MARKER}\nresponse B`);
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
  });

  it('is invariant to BOM, CRLF/CR, trailing whitespace, blank runs, NFD vs NFC, trailing newlines', () => {
    const base = canonicalPlanHash(`${PLAN_BEGIN_MARKER}\n# Plän\n\nline one\nline two\n${PLAN_END_MARKER}`);
    const noisy = canonicalPlanHash(
      `﻿${PLAN_BEGIN_MARKER}\r\n\r\n# Plän  \r\n\r\n\r\n\r\nline one\t \rline two   \n\n\n${PLAN_END_MARKER}`,
    );
    expect(base.ok && noisy.ok).toBe(true);
    if (base.ok && noisy.ok) {
      expect(noisy.canonical).toBe(base.canonical);
      expect(noisy.hash).toBe(base.hash);
      expect(base.canonical).toBe('# Plän\n\nline one\nline two\n');
      expect(base.hash).toBe(sha256Hex('# Plän\n\nline one\nline two\n'));
    }
  });

  it('changes when the plan content changes', () => {
    const a = canonicalPlanHash(plan('x'));
    const b = canonicalPlanHash(plan('y'));
    expect(a.ok && b.ok && a.hash !== b.hash).toBe(true);
  });

  it('pins a known vector', () => {
    expect(canonicalizePlanBody('a\n')).toBe('a\n');
    expect(sha256Hex('a\n')).toBe('87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7');
  });

  it('rejects missing, duplicated or out-of-order markers and empty bodies', () => {
    expect(extractPlanBody('no markers')).toEqual({ ok: false, error: 'markers_missing' });
    expect(extractPlanBody(`${PLAN_BEGIN_MARKER}${PLAN_BEGIN_MARKER}x${PLAN_END_MARKER}`)).toEqual({ ok: false, error: 'markers_duplicated' });
    expect(extractPlanBody(`${PLAN_END_MARKER}x${PLAN_BEGIN_MARKER}`)).toEqual({ ok: false, error: 'markers_out_of_order' });
    expect(canonicalPlanHash(`${PLAN_BEGIN_MARKER}\n \n\t\n${PLAN_END_MARKER}`)).toEqual({ ok: false, error: 'plan_body_empty' });
  });
});

// ===========================================================================
describe('round 1: partner pass', () => {
  it('runs read-only tools, stores the review VERBATIM and stays in_progress (≥2 passes)', async () => {
    const submitted = review();
    const { deps, llmCalls, ghCalls } = makeDeps([READ3, submit(submitted)]);
    const { session, deduplicated } = await createSparringSession(createBody(), deps);

    expect(deduplicated).toBe(false);
    expect(session.verdict).toBe('in_progress');
    expect(session.trust_tier).toBe('gateway');
    expect(session.rounds).toHaveLength(1);
    expect(session.rounds[0].review).toEqual(submitted);
    expect(session.rounds[0].evidence_floor).toEqual({ required: 3, verified: 3, met: true });
    expect(session.rounds[0].plan_hash).toBe(session.plan_hash);
    expect(session.rounds[0].plan_text).not.toContain('notes outside');
    expect(session.model_log).toHaveLength(2);
    expect(session.model_log[0]).toEqual(expect.objectContaining({ round: 1, provider: 'bedrock', input_tokens: 100, output_tokens: 50, ok: true }));

    // Every model call: stage plan_sparring, no fallback, adaptive thinking, high effort, fixed adversarial prompt.
    for (const c of llmCalls) {
      expect(c.stage).toBe('plan_sparring');
      expect(c.opts.allowFallback).toBe(false);
      expect(c.opts.thinking).toEqual({ type: 'adaptive' });
      expect(c.opts.effort).toBe('high');
      expect(c.opts.systemPrompt).toBe(PARTNER_SYSTEM_PROMPT);
      expect(c.opts.tools!.map((t) => t.name)).toEqual(['read_file', 'list_dir', 'search', 'submit_review']);
    }
    // Thinking blocks went back verbatim on the assistant tool turn.
    const h = llmCalls[1].opts.history!;
    expect(h[1]).toEqual(expect.objectContaining({ role: 'assistant', thinking: [THINK, REDACTED] }));
    expect(h[2]).toEqual(expect.objectContaining({ role: 'user', toolResults: expect.any(Array) }));

    // GitHub reads: pinned ref, dedicated token only.
    expect(ghCalls).toHaveLength(3);
    for (const g of ghCalls) {
      expect(g.url).toMatch(/^https:\/\/api\.github\.com\/repos\/exafyltd\/vitana-platform\/contents\/.+\?ref=a{40}$/);
      expect(g.headers.Authorization).toBe('Bearer sparring-token');
    }
    // Store discipline: rounds only via appendRound.
    expect(store.calls.filter((c) => c === 'appendRound')).toHaveLength(1);
  });

  it('rejects a round-1 review below the evidence floor, lets the partner fix it', async () => {
    const thin = review({ premise_checks: [review().premise_checks[0]] });
    const { deps, llmCalls } = makeDeps([READ3, submit(thin, 's1'), submit(review(), 's2')]);
    const { session } = await createSparringSession(createBody(), deps);
    expect(session.verdict).toBe('in_progress');
    const third = llmCalls[2].opts.history!;
    const rejection = third[third.length - 1] as { toolResults: Array<{ result: string; isError?: boolean }> };
    expect(rejection.toolResults[0].isError).toBe(true);
    expect(rejection.toolResults[0].result).toMatch(/round 1 needs at least 3/);
  });

  it('rejects citations of files that were never read with read_file', async () => {
    const fabricated = review({ findings: [{ id: 'R1-F1', severity: 'blocker', claim: 'x', evidence: ev('never/read.ts'), suggestion: 'y' }] });
    const { deps } = makeDeps([READ3, submit(fabricated, 'a'), submit(fabricated, 'b'), submit(fabricated, 'c')]);
    const { session } = await createSparringSession(createBody(), deps);
    expect(session.verdict).toBe('escalated');
    expect(session.escalation_reasons).toEqual(['partner_output_invalid']);
  });

  it('escalates evidence_floor_not_met when the partner never meets the floor', async () => {
    const thin = review({ premise_checks: [] });
    const { deps } = makeDeps([READ3, submit(thin, 'a'), submit(thin, 'b'), submit(thin, 'c')]);
    const { session } = await createSparringSession(createBody(), deps);
    expect(session.verdict).toBe('escalated');
    expect(session.escalation_reasons).toEqual(['evidence_floor_not_met']);
    expect(session.final_plan_hash).toBe(session.plan_hash);
  });

  it('model failure ⇒ escalated / model_unavailable after ONE call, nothing else called', async () => {
    const { deps, llmCalls, ghCalls } = makeDeps([() => ({ ok: false, error: 'Bedrock invoke_failed: AccessDeniedException', provider: 'bedrock', model: 'm' })]);
    const { session } = await createSparringSession(createBody(), deps);
    expect(session.verdict).toBe('escalated');
    expect(session.escalation_reasons).toEqual(['model_unavailable']);
    expect(session.rounds[0].partner_error).toMatch(/^model_unavailable: .*AccessDenied/);
    expect(session.rounds[0].review).toBeUndefined();
    expect(llmCalls).toHaveLength(1);
    expect(ghCalls).toHaveLength(0);
    expect(session.model_log).toEqual([expect.objectContaining({ ok: false, provider: 'bedrock' })]);
  });

  it('refuses an answer that did not come from the Bedrock partner (fallbackUsed)', async () => {
    const { deps } = makeDeps([() => ok({ provider: 'deepseek', fallbackUsed: true, text: 'hi' })]);
    const { session } = await createSparringSession(createBody(), deps);
    expect(session.escalation_reasons).toEqual(['model_unavailable']);
  });

  it('no PLAN_SPARRING_GITHUB_TOKEN ⇒ escalated code_access_unavailable with ZERO model calls', async () => {
    const { deps, llmCalls } = makeDeps([], { hasCodeAccess: () => false });
    const { session } = await createSparringSession(createBody(), deps);
    expect(session.verdict).toBe('escalated');
    expect(session.escalation_reasons).toEqual(['code_access_unavailable']);
    expect(llmCalls).toHaveLength(0);
  });

  it('caps tool calls per round', async () => {
    const many = readCalls(Array.from({ length: 35 }, (_, i) => `f${i}.ts`));
    const { deps, ghCalls } = makeDeps([many, submit(review({ findings: [], premise_checks: [
      { premise: 'p', holds: true, evidence: ev('f0.ts') },
      { premise: 'q', holds: true, evidence: ev('f1.ts') },
      { premise: 'r', holds: true, evidence: ev('f2.ts') },
    ] }))]);
    const { session } = await createSparringSession(createBody(), deps);
    expect(ghCalls).toHaveLength(30);
    expect(session.rounds[0].tool_log).toHaveLength(30);
  });

  it('nudges once when the partner answers in text, then escalates on a second refusal', async () => {
    const text: Step = () => ok({ text: 'Looks fine to me.' });
    const { deps, llmCalls } = makeDeps([text, text]);
    const { session } = await createSparringSession(createBody(), deps);
    expect(llmCalls[1].prompt).toMatch(/must finish this round by calling submit_review/);
    expect(session.escalation_reasons).toEqual(['partner_output_invalid']);
  });

  it('dedups an identical plan from the same producer (N7) without a model call', async () => {
    const first = makeDeps([READ3, submit(review())]);
    const a = await createSparringSession(createBody(), first.deps);
    const second = makeDeps([]);
    const b = await createSparringSession(createBody(PLAN_V1.replace('notes outside', 'other notes')), second.deps);
    expect(b.deduplicated).toBe(true);
    expect(b.session.id).toBe(a.session.id);
    expect(second.llmCalls).toHaveLength(0);
  });

  it('re-runs instead of dedup when the earlier session never got a review (model_unavailable)', async () => {
    const failed = makeDeps([() => ({ ok: false, error: 'down' })]);
    const a = await createSparringSession(createBody(), failed.deps);
    const retry = makeDeps([READ3, submit(review())]);
    const b = await createSparringSession(createBody(), retry.deps);
    expect(b.deduplicated).toBe(false);
    expect(b.session.id).not.toBe(a.session.id);
  });

  it('validates input', async () => {
    const { deps } = makeDeps([]);
    await expect(createSparringSession(createBody(PLAN_V1, { base_ref: 'main' }), deps)).rejects.toMatchObject({ status: 400, code: 'base_ref_must_be_commit_sha' });
    await expect(createSparringSession(createBody('no markers'), deps)).rejects.toMatchObject({ status: 400, code: 'markers_missing' });
    await expect(createSparringSession(createBody(PLAN_V1, { repo: 'evil/repo' }), deps)).rejects.toMatchObject({ status: 400, code: 'repo_invalid' });
    await expect(createSparringSession(createBody(PLAN_V1, { change_class: 'huge' }), deps)).rejects.toMatchObject({ status: 400 });
  });
});

// ===========================================================================
describe('later rounds + verdict', () => {
  async function round1() {
    const r1 = makeDeps([READ3, submit(review())]);
    const { session } = await createSparringSession(createBody(), r1.deps);
    return session;
  }

  it('every finding must be answered', async () => {
    const s = await round1();
    const { deps } = makeDeps([]);
    await expect(submitPlannerRound(s.id, { responses: [], revised_plan_text: PLAN_V2 }, deps)).rejects.toMatchObject({ status: 400, code: 'unanswered_findings:R1-F1' });
    await expect(
      submitPlannerRound(s.id, { responses: [{ finding_id: 'nope', disposition: 'accepted', rationale: 'x' }], revised_plan_text: PLAN_V2 }, deps),
    ).rejects.toMatchObject({ status: 400, code: 'unknown_finding:nope' });
  });

  it('converges when the revision closes every serious item; final_plan_hash = revised plan', async () => {
    const s = await round1();
    const r2 = review({ findings: [{ id: 'R2-F1', severity: 'minor', claim: 'nit', evidence: ev('services/gateway/src/index.ts'), suggestion: 's' }], premise_checks: [] });
    const { deps, llmCalls } = makeDeps([readCalls(['services/gateway/src/index.ts'], 'q'), submit(r2)]);
    const responses = [{ finding_id: 'R1-F1', disposition: 'accepted', rationale: 'Added a test.' }];
    const after = await submitPlannerRound(s.id, { responses, revised_plan_text: PLAN_V2 }, deps);

    expect(after.verdict).toBe('converged');
    const v2 = canonicalPlanHash(PLAN_V2);
    expect(v2.ok && after.final_plan_hash === v2.hash).toBe(true);
    expect(after.rounds).toHaveLength(2);
    expect(after.rounds[1].planner_responses).toEqual(responses);
    expect(after.rounds[1].review).toEqual(r2);
    // The partner saw its own previous findings verbatim + the responses + the revision.
    expect(llmCalls[0].prompt).toContain('"id": "R1-F1"');
    expect(llmCalls[0].prompt).toContain('Added a test.');
    expect(llmCalls[0].prompt).toContain('Adds a test.');
    expect(after.model_log).toHaveLength(4);
  });

  it('a disputed rejection keeps the session open; a re-raised major at the class cap escalates round_cap_reached', async () => {
    const s = await round1();
    const disputed = review({ findings: [], premise_checks: [], acknowledgements: [{ finding_id: 'R1-F1', status: 'disputed', note: 'rationale wrong' }] });
    const resp = [{ finding_id: 'R1-F1', disposition: 'rejected', rationale: 'Covered elsewhere.' }];

    const r2 = makeDeps([submit(disputed)]);
    const after2 = await submitPlannerRound(s.id, { responses: resp, revised_plan_text: PLAN_V2 }, r2.deps);
    expect(after2.verdict).toBe('in_progress'); // standard cap = 3

    // Round 3 answers round 2's findings (none) — the dispute carries in the record.
    const r3findings = review({ findings: [{ id: 'R1-F1', severity: 'major', claim: 're-raised', evidence: ev('services/gateway/src/index.ts'), suggestion: 's' }], premise_checks: [] });
    const r3 = makeDeps([readCalls(['services/gateway/src/index.ts'], 'z'), submit(r3findings)]);
    const after3 = await submitPlannerRound(s.id, { responses: [], revised_plan_text: PLAN_V2 }, r3.deps);
    expect(after3.verdict).toBe('escalated');
    expect(after3.escalation_reasons).toEqual(['round_cap_reached']);
  });

  it('light class escalates with round_cap_reached + disputed_items on pass 2', async () => {
    const r1 = makeDeps([READ3, submit(review())]);
    const { session } = await createSparringSession(createBody(PLAN_V1, { change_class: 'light' }), r1.deps);
    const disputed = review({ findings: [], premise_checks: [], acknowledgements: [{ finding_id: 'R1-F1', status: 'disputed' }] });
    const r2 = makeDeps([submit(disputed)]);
    const after = await submitPlannerRound(session.id, { responses: [{ finding_id: 'R1-F1', disposition: 'rejected', rationale: 'no' }], revised_plan_text: PLAN_V2 }, r2.deps);
    expect(after.verdict).toBe('escalated');
    expect(after.escalation_reasons).toEqual(['round_cap_reached', 'disputed_items']);
  });

  it('silence on a rejected serious finding counts as disputed', () => {
    const prev = [{ id: 'A', severity: 'blocker', claim: '', evidence: [], suggestion: '' }] as never;
    expect(unresolvedItems(prev, [{ finding_id: 'A', disposition: 'rejected', rationale: 'r' }], { findings: [], acknowledgements: [] })).toEqual({ open: [], disputed: ['A'] });
    expect(unresolvedItems(prev, [{ finding_id: 'A', disposition: 'rejected', rationale: 'r' }], { findings: [], acknowledgements: [{ finding_id: 'A', status: 'acknowledged' }] })).toEqual({ open: [], disputed: [] });
    expect(unresolvedItems(prev, [{ finding_id: 'A', disposition: 'accepted', rationale: 'r' }], { findings: [], acknowledgements: [] })).toEqual({ open: [], disputed: [] });
  });

  it('model failure in a later round escalates; no rounds accepted after a terminal verdict', async () => {
    const s = await round1();
    const { deps, llmCalls } = makeDeps([() => ({ ok: false, error: 'throttled' })]);
    const after = await submitPlannerRound(s.id, { responses: [{ finding_id: 'R1-F1', disposition: 'accepted', rationale: 'ok' }], revised_plan_text: PLAN_V2 }, deps);
    expect(after.verdict).toBe('escalated');
    expect(after.escalation_reasons).toEqual(['model_unavailable']);
    expect(llmCalls).toHaveLength(1);
    await expect(submitPlannerRound(s.id, { responses: [], revised_plan_text: PLAN_V2 }, deps)).rejects.toMatchObject({ status: 409 });
  });
});

// ===========================================================================
describe('approval (verified exafy_admin actor only)', () => {
  async function converged() {
    const r1 = makeDeps([READ3, submit(review())]);
    const { session } = await createSparringSession(createBody(), r1.deps);
    const r2 = makeDeps([submit(review({ findings: [], premise_checks: [] }))]);
    return submitPlannerRound(session.id, { responses: [{ finding_id: 'R1-F1', disposition: 'accepted', rationale: 'done' }], revised_plan_text: PLAN_V2 }, r2.deps);
  }

  it('records the verified actor, time and evidence; second approval is refused', async () => {
    const s = await converged();
    const { deps } = makeDeps([]);
    const approved = await approveSparringSession(s.id, { user_id: ADMIN, email: 'owner@example.com' }, { final_plan_hash: s.final_plan_hash, note: 'ship it' }, deps);
    expect(approved.human_approved_by).toBe(ADMIN);
    expect(approved.human_approved_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(approved.approval_evidence).toEqual(expect.objectContaining({ actor_user_id: ADMIN, actor_role: 'exafy_admin', verdict: 'converged', final_plan_hash: s.final_plan_hash, note: 'ship it' }));
    await expect(approveSparringSession(s.id, { user_id: ADMIN }, { final_plan_hash: s.final_plan_hash }, deps)).rejects.toMatchObject({ status: 409, code: 'already_approved' });
  });

  it('refuses a hash the approver did not see', async () => {
    const s = await converged();
    const { deps } = makeDeps([]);
    await expect(approveSparringSession(s.id, { user_id: ADMIN }, { final_plan_hash: 'f'.repeat(64) }, deps)).rejects.toMatchObject({ status: 409, code: 'final_plan_hash_mismatch' });
  });

  it('refuses in_progress sessions and requires explicit acknowledgement for escalated ones', async () => {
    const r1 = makeDeps([READ3, submit(review())]);
    const { session } = await createSparringSession(createBody(), r1.deps);
    const { deps } = makeDeps([]);
    await expect(approveSparringSession(session.id, { user_id: ADMIN }, {}, deps)).rejects.toMatchObject({ status: 409, code: 'not_ready_for_approval' });

    const down = makeDeps([() => ({ ok: false, error: 'down' })]);
    const { session: esc } = await createSparringSession(createBody(plan('other plan')), down.deps);
    await expect(approveSparringSession(esc.id, { user_id: ADMIN }, { final_plan_hash: esc.final_plan_hash }, deps)).rejects.toMatchObject({ status: 400, code: 'acknowledge_escalation_required' });
    const ok2 = await approveSparringSession(esc.id, { user_id: ADMIN }, { final_plan_hash: esc.final_plan_hash, acknowledge_escalation: true }, deps);
    expect(ok2.approval_evidence).toEqual(expect.objectContaining({ verdict: 'escalated', escalation_reasons: ['model_unavailable'] }));
  });

  it('refuses attested records (gateway pass required) and unverified actors', async () => {
    const s = await converged();
    store.sessions.get(s.id)!.trust_tier = 'attested';
    const { deps } = makeDeps([]);
    await expect(approveSparringSession(s.id, { user_id: ADMIN }, { final_plan_hash: s.final_plan_hash }, deps)).rejects.toMatchObject({ status: 409, code: 'gateway_pass_required' });
    await expect(approveSparringSession(s.id, { user_id: 'not-a-uuid' }, {}, deps)).rejects.toMatchObject({ status: 403 });
  });

  it('GET returns the record; unknown id is 404', async () => {
    const s = await converged();
    const { deps } = makeDeps([]);
    expect((await getSparringSession(s.id, deps)).id).toBe(s.id);
    await expect(getSparringSession('00000000-0000-4000-8000-999999999999', deps)).rejects.toBeInstanceOf(SparringError);
  });
});

// ===========================================================================
describe('real router path: model failure ⇒ zero other provider calls', () => {
  it('a Bedrock AccessDenied escalates the session; Bedrock called once, DeepSeek/fetch never', async () => {
    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/test';
    process.env.DEEPSEEK_API_KEY = 'k';
    _resetPolicyCacheForTests();
    sendMock.mockReset();
    sendMock.mockRejectedValue(new Error('AccessDeniedException: not subscribed'));
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { deps } = makeDeps([]);
    deps.callLlm = callViaRouter;
    const { session } = await createSparringSession(createBody(plan('router path')), deps);

    expect(session.verdict).toBe('escalated');
    expect(session.escalation_reasons).toEqual(['model_unavailable']);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = JSON.parse((sendMock.mock.calls[0][0] as { input: { body: string } }).input.body);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['read_file', 'list_dir', 'search', 'submit_review']);
  });
});

// ===========================================================================
describe('GitHub tools (read-only, pinned, dedicated token)', () => {
  const fileResp = { ok: true, status: 200, json: async () => ({ type: 'file', encoding: 'base64', content: Buffer.from('a\nb\nc\nd').toString('base64') }), text: async () => '' };

  it('uses PLAN_SPARRING_GITHUB_TOKEN, never GITHUB_TOKEN / GITHUB_SAFE_MERGE_TOKEN', async () => {
    const prev = { ...process.env };
    process.env.GITHUB_TOKEN = 'merge-capable';
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'merge-token';
    process.env.PLAN_SPARRING_GITHUB_TOKEN = 'read-only-token';
    const fetchImpl = jest.fn(async () => fileResp);
    const exec = createCodeToolExecutor({ refs: { 'exafyltd/vitana-platform': SHA }, fetchImpl: fetchImpl as never });
    const r = await exec('read_file', { repo: 'exafyltd/vitana-platform', path: 'x.ts', start_line: 2, end_line: 3 });
    expect(r.isError).toBe(false);
    expect(r.result).toContain('lines 2-3 of 4');
    expect(r.result).toMatch(/\n\s+2 {2}b\n\s+3 {2}c$/);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer read-only-token');
    process.env = prev;
  });

  it('without the dedicated token every tool fails closed (no fallback to GITHUB_TOKEN)', async () => {
    const prev = { ...process.env };
    delete process.env.PLAN_SPARRING_GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'merge-capable';
    const fetchImpl = jest.fn();
    const exec = createCodeToolExecutor({ refs: { 'exafyltd/vitana-platform': SHA }, fetchImpl: fetchImpl as never });
    const r = await exec('read_file', { repo: 'exafyltd/vitana-platform', path: 'x.ts' });
    expect(r.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    process.env = prev;
  });

  it('refuses other repos, path traversal and unpinned repos', async () => {
    const fetchImpl = jest.fn(async () => fileResp);
    const exec = createCodeToolExecutor({ refs: { 'exafyltd/vitana-platform': SHA }, token: 't', fetchImpl: fetchImpl as never });
    expect((await exec('read_file', { repo: 'someone/else', path: 'a' })).isError).toBe(true);
    expect((await exec('read_file', { repo: 'exafyltd/vitana-platform', path: '../secrets' })).isError).toBe(true);
    expect((await exec('read_file', { repo: 'exafyltd/vitana-v1', path: 'a' })).result).toMatch(/no pinned ref/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('search is marked approximate and is not read_file evidence', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [{ path: 'a.ts' }] }), text: async () => '' }));
    const exec = createCodeToolExecutor({ refs: {}, token: 't', fetchImpl: fetchImpl as never });
    const r = await exec('search', { repo: 'exafyltd/vitana-v1', query: 'useRole' });
    expect(r.result).toMatch(/^APPROXIMATE/);
    expect(r.log).toEqual(expect.objectContaining({ name: 'search', approximate: true }));
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain('/search/code?');
  });

  it('tool schemas expose no ref parameter (the ref is pinned, not chosen)', () => {
    for (const t of PARTNER_CODE_TOOLS) expect(JSON.stringify(t.inputSchema)).not.toMatch(/"ref"/);
    expect(SUBMIT_REVIEW_TOOL.name).toBe('submit_review');
  });
});

// ===========================================================================
describe('OASIS at allocation', () => {
  it('emits attached with a sparring id, missing without', async () => {
    const emit = jest.fn(async () => ({ ok: true }));
    await emitAllocationSparringEvent({ vtid: 'VTID-09999', sparringId: ADMIN, source: 'api' }, emit);
    await emitAllocationSparringEvent({ vtid: 'VTID-09998', sparringId: null, source: 'api' }, emit);
    expect(emit.mock.calls.map((c: any[]) => [c[0].vtid, c[0].type, c[0].status])).toEqual([
      ['VTID-09999', 'vtid.plan_sparring.attached', 'info'],
      ['VTID-09998', 'vtid.plan_sparring.missing', 'warning'],
    ]);
    for (const c of emit.mock.calls as any[]) {
      expect(c[0]).toEqual(expect.objectContaining({ source: 'plan-sparring-gate', message: expect.any(String) }));
    }
  });

  it('never throws into the allocation path', async () => {
    await expect(emitAllocationSparringEvent({ vtid: 'VTID-1', sparringId: null, source: 'x' }, async () => { throw new Error('down'); })).resolves.toBeUndefined();
  });

  it('parseSparringId accepts only UUIDs', () => {
    expect(parseSparringId(ADMIN)).toBe(ADMIN);
    expect(parseSparringId('x')).toBeNull();
    expect(parseSparringId(undefined)).toBeNull();
  });
});

// ===========================================================================
describe('reconciler (hourly, read-only, off by default)', () => {
  const T0 = Date.parse('2026-10-04T10:00:00Z');

  it('is disabled unless PLAN_SPARRING_RECONCILER_ENABLED=true', () => {
    delete process.env.PLAN_SPARRING_RECONCILER_ENABLED;
    expect(isReconcilerEnabled()).toBe(false);
    expect(startPlanSparringReconciler(() => { throw new Error('must not build deps'); })).toBe(false);
  });

  it('clean run emits nothing', async () => {
    const emit = jest.fn(async () => ({}));
    const d = await runPlanSparringReconcile({ sb: {} as never, emit, now: () => T0 }, newReconcilerState());
    expect(d).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('detects a disabled trigger, ledger rows without sparring_id, break-glass rows and config change', async () => {
    const state = newReconcilerState();
    const emit = jest.fn(async () => ({}));
    await runPlanSparringReconcile({ sb: {} as never, emit, now: () => T0 }, state); // baseline

    store.trigger = { present: true, tgenabled: 'D' };
    store.ledger = [
      { vtid: 'VTID-10001', created_at: '2026-10-04T10:30:00.000Z', metadata: {} },
      { vtid: 'VTID-10002', created_at: '2026-10-04T10:31:00.000Z', metadata: { sparring_exempt_reason: 'P1 incident' } },
      { vtid: 'VTID-10003', created_at: '2026-10-04T10:32:00.000Z', metadata: { sparring_id: ADMIN } },
      { vtid: 'VTID-09000', created_at: '2026-10-04T09:00:00.000Z', metadata: {} },
    ];
    store.config = { id: 1, mode: 'off' };
    const d = await runPlanSparringReconcile({ sb: {} as never, emit, now: () => T0 + 3_600_000 }, state);

    expect(d.map((x) => x.check).sort()).toEqual(['break_glass', 'config_changed', 'ledger_rows_without_sparring', 'trigger_disabled']);
    expect(d.find((x) => x.check === 'ledger_rows_without_sparring')!.detail).toEqual(expect.objectContaining({ count: 1, vtids: ['VTID-10001'] }));
    const types = (emit.mock.calls as any[]).map((c) => c[0].type).sort();
    expect(types).toEqual(['vtid.plan_sparring.break_glass', 'vtid.plan_sparring.tamper_detected', 'vtid.plan_sparring.tamper_detected', 'vtid.plan_sparring.tamper_detected']);
    // Read-only: only read functions of the repository were touched.
    expect(new Set(store.calls)).toEqual(new Set(['fetchTriggerStatus', 'fetchLedgerRowsWithoutSparring', 'fetchConfig']));
  });

  it('an unreadable trigger status or missing config is reported, never assumed fine', async () => {
    store.triggerError = { message: 'function plan_sparring_trigger_status() does not exist' };
    store.config = null;
    const emit = jest.fn(async () => ({}));
    const d = await runPlanSparringReconcile({ sb: {} as never, emit, now: () => T0 }, newReconcilerState());
    expect(d.map((x) => x.check).sort()).toEqual(['config_missing', 'trigger_status_unreadable']);
  });
});
