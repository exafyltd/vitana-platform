/**
 * VTID-04473: decide() / decideMany() — gate, validation, PII, threshold,
 * fallback and telemetry. The Jev call is injected; OASIS emit is captured.
 */
const emitted: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: any) => {
    emitted.push(e);
    return { ok: true };
  }),
}));

import { decide, decideMany } from '../src/services/jev/jev-decision-service';
import { getJevStats, resetJevStatsForTest } from '../src/services/jev/jev-telemetry';
import type { JevCallResult } from '../src/services/jev/jev-client';

const ENV = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const staff = { actor_id: 'user-1', active_role: 'staff', tenant_id: 't1' };

function ok(answers: any, input_tokens = 1000): JevCallResult {
  return { ok: true, model: 'jev-1.13.0', answers, usage: { input_tokens, output_tokens: 2 }, latency_ms: 40, attempts: 1 };
}

const ticketAnswers = (confidence: number) => ({
  category: { type: 'choice', choice: 'billing', probabilities: { billing: confidence }, confidence },
  urgency: { type: 'score', score: 2, probabilities: [0.05, 0.1, 0.8, 0.05], confidence: 0.8 },
});

beforeEach(() => {
  emitted.length = 0;
  resetJevStatsForTest();
});

describe('VTID-04473 decide()', () => {
  test('decides, interprets every answer, prices input tokens and emits one event', async () => {
    const call = jest.fn().mockResolvedValue(ok(ticketAnswers(0.92), 1_000_000));
    const r = await decide('support_ticket_triage', { body: 'I was charged twice' }, staff, { source: 'test', call, env: ENV });
    expect(r).toMatchObject({ ok: true, outcome: 'decided', plane: 'internal', cost_usd: 0.042 });
    if (!r.ok) throw new Error('expected ok');
    expect(r.verdict).toMatchObject({ type: 'choice', value: 'billing', confidence: 0.92 });
    expect(r.answers.urgency).toMatchObject({ type: 'score', value: 2, label: 'Blocks the member from using a feature' });
    await new Promise((s) => setImmediate(s));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'jev.decision.completed', vtid: 'VTID-04473' });
    expect(emitted[0].payload).toMatchObject({ decision: 'support_ticket_triage', plane: 'internal', role: 'staff', input_tokens: 1_000_000 });
    // the state never travels in telemetry
    expect(JSON.stringify(emitted[0])).not.toContain('charged twice');
  });

  test('below the threshold it abstains (answers kept, caller keeps its own path)', async () => {
    const call = jest.fn().mockResolvedValue(ok(ticketAnswers(0.4)));
    const r = await decide('support_ticket_triage', { body: 'hmm' }, staff, { source: 'test', call, env: ENV });
    expect(r).toMatchObject({ ok: true, outcome: 'abstained' });
  });

  test('community is refused before anything else happens', async () => {
    const call = jest.fn();
    const r = await decide('support_ticket_triage', { body: 'x' }, { actor_id: 'm', active_role: 'community' }, { source: 'test', call, env: ENV });
    expect(r).toMatchObject({ ok: false, outcome: 'denied', reason: 'community_not_enabled', status: 403 });
    expect(call).not.toHaveBeenCalled();
  });

  test('a role not listed on the decision is refused', async () => {
    const call = jest.fn();
    const r = await decide('contract_clause_flag', { clause_type: 'termination', excerpt: 'x' }, { actor_id: 'd', active_role: 'developer' }, { source: 'test', call, env: ENV });
    expect(r).toMatchObject({ ok: false, reason: 'decision_not_permitted_for_role' });
    expect(call).not.toHaveBeenCalled();
  });

  test('unknown decision → 404, bad input → 400 with the field named', async () => {
    expect(await decide('nope', {}, staff, { source: 't', env: ENV })).toMatchObject({ reason: 'unknown_decision', status: 404 });
    const r = await decide('support_ticket_triage', { subject: 'no body' }, staff, { source: 't', env: ENV });
    expect(r).toMatchObject({ reason: 'invalid_input', status: 400 });
    if (!r.ok) expect(r.detail).toMatch(/body/);
  });

  test('PII is redacted before the state leaves', async () => {
    const call = jest.fn().mockResolvedValue(ok(ticketAnswers(0.9)));
    const r = await decide('support_ticket_triage', { body: 'write me at anna@example.com' }, staff, { source: 't', call, env: ENV });
    expect(JSON.stringify(call.mock.calls[0][0].state)).not.toContain('anna@example.com');
    expect(r).toMatchObject({ ok: true, redactions: 1 });
  });

  test('not configured → fallback 503, telemetry says fallback not failed', async () => {
    const r = await decide('support_ticket_triage', { body: 'x' }, staff, { source: 't', env: {} });
    expect(r).toMatchObject({ ok: false, outcome: 'fallback', reason: 'not_configured', status: 503 });
    await new Promise((s) => setImmediate(s));
    expect(emitted[0]).toMatchObject({ type: 'jev.decision.fallback' });
  });

  test('a provider error is reported as failed, never as a silent default', async () => {
    const call = jest.fn().mockResolvedValue({ ok: false, reason: 'http_error', status: 529, error: 'overloaded', latency_ms: 5, attempts: 2 });
    const r = await decide('ci_failure_bucket', { check_name: 'jest', log_excerpt: 'x' }, { actor_id: 'd', active_role: 'developer' }, { source: 't', call, env: ENV });
    expect(r).toMatchObject({ ok: false, outcome: 'fallback', reason: 'http_error' });
    await new Promise((s) => setImmediate(s));
    expect(emitted[0]).toMatchObject({ type: 'jev.decision.failed', status: 'error' });
  });

  test('stats split by plane, decision and role', async () => {
    const call = jest.fn().mockResolvedValue(ok(ticketAnswers(0.9), 500_000));
    await decide('support_ticket_triage', { body: 'a' }, staff, { source: 't', call, env: ENV });
    await decide('support_ticket_triage', { body: 'b' }, { actor_id: 'x', exafy_admin: true }, { source: 't', call, env: ENV });
    const s = getJevStats();
    expect(s.total).toMatchObject({ calls: 2, decided: 2, input_tokens: 1_000_000 });
    expect(s.by_plane.internal.calls).toBe(2);
    expect(s.by_role.staff.calls).toBe(1);
    expect(s.by_role.exafy_admin.calls).toBe(1);
    expect(s.total.cost_usd).toBeCloseTo(0.042, 8);
  });
});

describe('VTID-04473 decideMany()', () => {
  test('keeps input order and never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const call = jest.fn(async (args: any) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((s) => setTimeout(s, 5));
      inFlight--;
      const relevant = String(args.state.document.text).includes('yes');
      return ok({
        relevant: { type: 'noul', noul: relevant ? 0.95 : 0.05 },
        strength: { type: 'score', score: relevant ? 3 : 0, probabilities: relevant ? [0, 0, 0.1, 0.9] : [0.9, 0.1, 0, 0], confidence: 0.9 },
      });
    });
    const inputs = Array.from({ length: 20 }, (_, i) => ({ query: 'invoices', text: i % 3 === 0 ? `doc ${i} yes` : `doc ${i}` }));
    const rs = await decideMany('document_relevance', inputs, { actor_id: 'b', active_role: 'backoffice' }, { source: 't', call, env: ENV, concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(rs).toHaveLength(20);
    rs.forEach((r, i) => {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.verdict.value).toBe(i % 3 === 0);
    });
  });
});
