/**
 * Machine-only verdict import (GitLab cutover plan). The repository is an in-memory fake that
 * enforces the same rules as the table: one session per plan, round numbering, the policy approval
 * only on a converged, unapproved session with its own policy.
 */
import express from 'express';
import request from 'supertest';
import {
  importVerdict,
  validateVerdictImport,
  recordDigest,
  canonicalJson,
  planIdFromHash,
  IMPORT_PLAN_HASH,
  type VerdictImportInput,
} from '../../src/services/plan-sparring/verdict-import';
import { createPlansSparRouter } from '../../src/routes/plans-spar';

const mockStore: { sessions: Array<Record<string, any>>; seq: number } = { sessions: [], seq: 0 };

jest.mock('../../src/services/plan-sparring/plan-sparring-repository', () => {
  const actual = jest.requireActual('../../src/services/plan-sparring/plan-sparring-repository');
  const clone = (s: any) => (s ? JSON.parse(JSON.stringify(s)) : null);
  return {
    ...actual,
    isRoundConflict: (e: { code?: string } | null | undefined) => e?.code === 'PS409',
    insertSession: async (_sb: unknown, row: Record<string, any>) => {
      const s = {
        id: `sess-${++mockStore.seq}`,
        plan_hash: row.plan_hash,
        final_plan_hash: null,
        producer: row.producer,
        change_class: row.change_class,
        trust_tier: row.trust_tier,
        base_ref: row.base_ref,
        approval_policy: row.approval_policy ?? null,
        policy_approved_at: null,
        policy_approval_rule: null,
        human_approved_by: null,
        verdict: row.verdict ?? 'in_progress',
        rounds: [],
        model_log: [],
        escalation_reasons: [],
        plan_id: row.plan_id,
      };
      mockStore.sessions.push(s);
      return { data: clone(s), error: null };
    },
    fetchSession: async (_sb: unknown, id: string) => ({ data: clone(mockStore.sessions.find((x) => x.id === id) ?? null), error: null }),
    fetchSessionByPlanHash: async (_sb: unknown, producer: string, hash: string) => {
      const hit = [...mockStore.sessions].reverse().find((x) => x.producer === producer && x.plan_hash === hash);
      return { data: clone(hit ?? null), error: null };
    },
    appendRound: async (_sb: unknown, id: string, round: Record<string, any>, expected: number) => {
      const s = mockStore.sessions.find((x) => x.id === id);
      if (!s) return { data: null, error: { message: 'no session' } };
      if (s.rounds.length !== expected) return { data: null, error: { message: 'stale round', code: 'PS409' } };
      s.rounds.push(clone(round));
      return { data: { ok: true }, error: null };
    },
    updateSessionState: async (_sb: unknown, id: string, patch: Record<string, any>) => {
      const s = mockStore.sessions.find((x) => x.id === id);
      Object.assign(s, clone(patch));
      return { data: null, error: null };
    },
    recordPolicyApproval: async (_sb: unknown, id: string, a: { rule: string; at: string }) => {
      const s = mockStore.sessions.find((x) => x.id === id);
      if (!s || s.verdict !== 'converged' || s.approval_policy !== a.rule || s.policy_approved_at || s.human_approved_by) {
        return { data: [], error: null };
      }
      s.policy_approved_at = a.at;
      s.policy_approval_rule = a.rule;
      return { data: [{ id }], error: null };
    },
  };
});


/** SparringError keeps the machine code in `.code`; assert on it, not on the detail text. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e: any) {
    return e?.code;
  }
  return undefined;
}

const H = IMPORT_PLAN_HASH;
const round = (n: number) => ({ round: n, at: '2026-11-17T00:00:00Z', plan_hash: H, plan_text: `plan r${n}`, findings: [], responses: [] });

function escalatedRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const base = {
    plan_hash: H,
    producer: 'gitlab-cutover',
    change_class: 'standard',
    base_ref: 'gitlab-cutover-base',
    verdict: 'escalated',
    final_plan_hash: H,
    escalation_reasons: ['round_cap_reached'],
    model_log: [],
    rounds: [round(1), round(2), round(3)],
  };
  const merged = { ...base, ...overrides };
  const record_sha256 = recordDigest(merged as any);
  return { ...merged, record_sha256 };
}

function audit(): { events: Array<Record<string, unknown>>; fn: (e: Record<string, unknown>) => void } {
  const events: Array<Record<string, unknown>> = [];
  return { events, fn: (e) => events.push(e) };
}

beforeEach(() => {
  mockStore.sessions = [];
  mockStore.seq = 0;
});

describe('validateVerdictImport: only the complete approved hash, and an exact record', () => {
  it('accepts the approved record', () => {
    expect(() => validateVerdictImport(escalatedRecord())).not.toThrow();
  });
  it('refuses a prefix of the approved hash', () => {
    expect(codeOf(() => validateVerdictImport(escalatedRecord({ plan_hash: H.slice(0, 8), final_plan_hash: H.slice(0, 8) })))).toBe('plan_hash_invalid');
  });
  it('refuses a different full hash', () => {
    const other = '0'.repeat(64);
    expect(codeOf(() => validateVerdictImport(escalatedRecord({ plan_hash: other, final_plan_hash: other })))).toBe('plan_hash_not_approved');
  });
  it('refuses an uppercase copy of the approved hash', () => {
    const up = H.toUpperCase();
    expect(codeOf(() => validateVerdictImport(escalatedRecord({ plan_hash: up, final_plan_hash: up })))).toBe('plan_hash_invalid');
  });
  it('refuses a wrong producer, an unknown verdict and a non-approved final hash', () => {
    expect(codeOf(() => validateVerdictImport(escalatedRecord({ producer: 'someone-else' })))).toBe('producer_invalid');
    expect(codeOf(() => validateVerdictImport(escalatedRecord({ verdict: 'pending_human_approval' })))).toBe('verdict_invalid');
    expect(codeOf(() => validateVerdictImport(escalatedRecord({ final_plan_hash: '1'.repeat(64) })))).toBe('final_plan_hash_invalid');
  });
  it('refuses a record whose content was changed after its digest was computed', () => {
    const rec = escalatedRecord();
    expect(codeOf(() => validateVerdictImport({ ...rec, escalation_reasons: ['tampered'] }))).toBe('record_digest_mismatch');
  });
  it('refuses rounds that are not numbered 1..n', () => {
    expect(codeOf(() => validateVerdictImport(escalatedRecord({ rounds: [round(2)] })))).toBe('rounds_out_of_order');
  });
  it('requires a digest', () => {
    const { record_sha256: _drop, ...rest } = escalatedRecord() as any;
    expect(codeOf(() => validateVerdictImport(rest))).toBe('record_digest_required');
  });
});

describe('digest is canonical', () => {
  it('does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('plan id is deterministic from the plan hash', () => {
    expect(planIdFromHash(H)).toBe(planIdFromHash(H));
    expect(planIdFromHash(H)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('importVerdict: creation, policy path and no human approval', () => {
  it('creates an ESCALATED session with its three rounds, awaiting the owner, and never policy-approves it', async () => {
    const a = audit();
    const out = await importVerdict(escalatedRecord(), { sb: {} as any, audit: a.fn });
    expect(out.deduplicated).toBe(false);
    const s = mockStore.sessions[0];
    expect(s.verdict).toBe('escalated');
    expect(s.final_plan_hash).toBe(H);
    expect(s.rounds).toHaveLength(3);
    expect(s.policy_approved_at).toBeNull();
    expect(s.human_approved_by).toBeNull();
    expect(a.events.map((e) => e.decision)).toEqual(['created']);
  });

  it('a CONVERGED record receives the existing converged-auto-v1 policy approval', async () => {
    const rec = escalatedRecord({ verdict: 'converged', escalation_reasons: [] });
    const body = { ...rec, record_sha256: recordDigest({ ...(rec as any), verdict: 'converged', escalation_reasons: [] }) };
    // a converged verdict is only policy-approved when it carries its own approval_policy at creation
    const a = audit();
    await importVerdict(body, { sb: {} as any, audit: a.fn });
    const s = mockStore.sessions[0];
    expect(s.approval_policy).toBe('converged-auto-v1');
    expect(s.policy_approval_rule).toBe('converged-auto-v1');
    expect(s.policy_approved_at).not.toBeNull();
    expect(s.human_approved_by).toBeNull();
  });
});

describe('replay protection', () => {
  it('importing the same record twice creates nothing new and returns the existing session', async () => {
    const a = audit();
    const first = await importVerdict(escalatedRecord(), { sb: {} as any, audit: a.fn });
    const second = await importVerdict(escalatedRecord(), { sb: {} as any, audit: a.fn });
    expect(mockStore.sessions).toHaveLength(1);
    expect(mockStore.sessions[0].rounds).toHaveLength(3);
    expect(second.deduplicated).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(a.events.map((e) => e.decision)).toEqual(['created', 'deduplicated']);
  });

  it('a different record for the same plan is refused and nothing is overwritten', async () => {
    const a = audit();
    await importVerdict(escalatedRecord(), { sb: {} as any, audit: a.fn });
    const changed = escalatedRecord({ escalation_reasons: ['different_reason'] });
    await expect(importVerdict(changed, { sb: {} as any, audit: a.fn })).rejects.toMatchObject({ status: 409, code: 'import_conflict' });
    expect(mockStore.sessions).toHaveLength(1);
    expect(mockStore.sessions[0].escalation_reasons).toEqual(['round_cap_reached']);
    expect(a.events.map((e) => e.decision)).toEqual(['created', 'refused_conflict']);
  });

  it('a partial import (in_progress with one round) is resumed without duplicating the round', async () => {
    mockStore.sessions.push({
      id: 'sess-partial', plan_hash: H, final_plan_hash: null, producer: 'gitlab-cutover', change_class: 'standard', trust_tier: 'attested',
      base_ref: 'gitlab-cutover-base', approval_policy: null, policy_approved_at: null, policy_approval_rule: null, human_approved_by: null,
      verdict: 'in_progress', rounds: [JSON.parse(JSON.stringify(round(1)))], model_log: [], escalation_reasons: [],
    });
    const a = audit();
    const out = await importVerdict(escalatedRecord(), { sb: {} as any, audit: a.fn });
    expect(out.resumed).toBe(true);
    expect(mockStore.sessions).toHaveLength(1);
    expect(mockStore.sessions[0].rounds.map((r: any) => r.round)).toEqual([1, 2, 3]);
    expect(mockStore.sessions[0].verdict).toBe('escalated');
  });

  it('a resumed session whose round 1 differs from the record is refused, not repaired silently', async () => {
    mockStore.sessions.push({
      id: 'sess-bad', plan_hash: H, final_plan_hash: null, producer: 'gitlab-cutover', change_class: 'standard', trust_tier: 'attested',
      base_ref: 'gitlab-cutover-base', approval_policy: null, policy_approved_at: null, policy_approval_rule: null, human_approved_by: null,
      verdict: 'in_progress', rounds: [{ ...round(1), plan_text: 'DIFFERENT' }], model_log: [], escalation_reasons: [],
    });
    await expect(importVerdict(escalatedRecord(), { sb: {} as any, audit: audit().fn })).rejects.toMatchObject({ status: 409, code: 'import_conflict' });
  });
});

describe('route: authentication and authorisation', () => {
  const ENV0 = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV0, GATEWAY_SERVICE_TOKEN: 'svc-token-import' };
  });
  afterAll(() => {
    process.env = ENV0;
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/plans/spar', createPlansSparRouter(() => ({ sb: {} as any, emit: () => undefined } as any)));
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  afterAll(() => logSpy.mockRestore());

  it('refuses a request without a bearer token', async () => {
    const r = await request(app).post('/api/v1/plans/spar/import').send(escalatedRecord());
    expect(r.status).toBe(401);
    expect(mockStore.sessions).toHaveLength(0);
  });
  it('refuses a wrong bearer token', async () => {
    const r = await request(app).post('/api/v1/plans/spar/import').set('Authorization', 'Bearer nope').send(escalatedRecord());
    expect(r.status).toBe(401);
    expect(mockStore.sessions).toHaveLength(0);
  });
  it('accepts the gateway service token and creates the session (201), then replays as 200', async () => {
    const first = await request(app).post('/api/v1/plans/spar/import').set('Authorization', 'Bearer svc-token-import').send(escalatedRecord());
    expect(first.status).toBe(201);
    expect(first.body.ok).toBe(true);
    const second = await request(app).post('/api/v1/plans/spar/import').set('Authorization', 'Bearer svc-token-import').send(escalatedRecord());
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(mockStore.sessions).toHaveLength(1);
  });
  it('a prefix of the approved hash is refused with 422 and writes nothing', async () => {
    const r = await request(app)
      .post('/api/v1/plans/spar/import')
      .set('Authorization', 'Bearer svc-token-import')
      .send(escalatedRecord({ plan_hash: H.slice(0, 12), final_plan_hash: H.slice(0, 12) }));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('plan_hash_invalid');
    expect(mockStore.sessions).toHaveLength(0);
  });
  it('the import route is not reachable without the service token even with a valid body', async () => {
    const r = await request(app).post('/api/v1/plans/spar/import').send(escalatedRecord());
    expect(r.status).toBe(401);
  });
});

// Type-only use keeps the import of VerdictImportInput honest.
export type _Input = VerdictImportInput;
