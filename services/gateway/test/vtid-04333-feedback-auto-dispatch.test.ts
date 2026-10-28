/**
 * VTID-04333 — owner decision: every bug / ux_issue ticket with a real spec is
 * dispatched to Dev Autopilot without an "Approve & Fix" click. Behind
 * FEEDBACK_AUTO_DISPATCH_ENABLED, the kill switch, a per-pass cap and an
 * attempt limit; never another kind.
 */
const mockEmit = jest.fn();
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: unknown[]) => { mockEmit(...a); return Promise.resolve({ ok: true }); },
}));

import {
  autoDispatchReadyTickets,
  autoDispatchPerTick,
  draftPlaceholderSpecsTick,
  isAutoDispatchEnabled,
  resetSpecDraftThrottle,
  MAX_AUTO_DISPATCH_ATTEMPTS,
} from '../src/services/feedback-spec-drafter';

const S = { url: 'https://sb.test', key: 'svc' };
const ON = { FEEDBACK_AUTO_DISPATCH_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;
const REAL_SPEC = '# FB-2026-09-000010 — Save button does nothing\n\n## Files to touch\n- services/gateway/src/services/x.ts';
const PLACEHOLDER = '# Devon auto-draft spec (placeholder)\n\nUser report: x';

type Call = { url: string; method: string; body: any };
let calls: Call[];
let tickets: any[];
let killSwitch: boolean | null;

function ticket(id: string, over: Record<string, unknown> = {}) {
  return { id, ticket_number: `FB-2026-09-0000${id.slice(-2)}`, kind: 'bug', status: 'spec_ready', spec_md: REAL_SPEC,
    classifier_meta: {}, linked_finding_id: null, linked_vtid: null, ...over };
}

beforeEach(() => {
  resetSpecDraftThrottle();
  mockEmit.mockReset();
  calls = [];
  killSwitch = false;
  tickets = [ticket('t-01'), ticket('t-02', { kind: 'ux_issue' })];
  (global as any).fetch = jest.fn(async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.includes('/dev_autopilot_config')) {
      return { ok: true, json: async () => (killSwitch === null ? [] : [{ kill_switch: killSwitch }]) } as any;
    }
    if (method === 'PATCH') return { ok: true, json: async () => [{ id: 'x' }] } as any;
    if (url.includes('spec_md=ilike.*placeholder*')) return { ok: true, json: async () => [] } as any;
    return { ok: true, json: async () => tickets } as any;
  });
});

describe('flag', () => {
  it('only the exact string "true" enables it', () => {
    expect(isAutoDispatchEnabled(ON)).toBe(true);
    expect(isAutoDispatchEnabled({ FEEDBACK_AUTO_DISPATCH_ENABLED: 'TRUE' } as any)).toBe(false);
    expect(isAutoDispatchEnabled({} as any)).toBe(false);
  });
  it('per-tick cap defaults to 2 and is bounded', () => {
    expect(autoDispatchPerTick({} as any)).toBe(2);
    expect(autoDispatchPerTick({ FEEDBACK_AUTO_DISPATCH_PER_TICK: '50' } as any)).toBe(10);
    expect(autoDispatchPerTick({ FEEDBACK_AUTO_DISPATCH_PER_TICK: 'x' } as any)).toBe(2);
  });
});

describe('autoDispatchReadyTickets', () => {
  it('is off unless the flag is set — no DB call, no dispatch', async () => {
    const dispatch = jest.fn();
    const r = await autoDispatchReadyTickets(S, { dispatch, env: {} as any });
    expect(r.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('dispatches bug and ux_issue tickets with a real spec as actor auto-dispatch', async () => {
    const dispatch = jest.fn().mockResolvedValue({ ok: true, vtid: 'VTID-04600', execution_id: 'ex-1' });
    const r = await autoDispatchReadyTickets(S, { dispatch, env: ON });
    expect(r).toEqual({ dispatched: 2, failed: 0, skipped: 0 });
    expect(dispatch).toHaveBeenCalledWith('t-01', 'auto-dispatch');
    expect(dispatch).toHaveBeenCalledWith('t-02', 'auto-dispatch');
    const sweep = calls.find((c) => c.url.includes('/feedback_tickets?') && c.method === 'GET')!;
    expect(sweep.url).toContain('kind=in.(bug,ux_issue)');
    expect(sweep.url).toContain('status=eq.spec_ready');
    expect(sweep.url).toContain('linked_finding_id=is.null');
    // claim is guarded on spec_ready and counts the attempt
    const claim = calls.find((c) => c.method === 'PATCH')!;
    expect(claim.url).toContain('status=eq.spec_ready');
    expect(claim.body.classifier_meta.auto_dispatch_attempts).toBe(1);
  });

  it('never touches another kind, a placeholder spec or an already linked ticket', async () => {
    tickets = [
      ticket('t-03', { kind: 'support_question' }),
      ticket('t-04', { spec_md: PLACEHOLDER }),
      ticket('t-05', { linked_finding_id: 'rec-9' }),
      ticket('t-06', { status: 'in_progress' }),
    ];
    const dispatch = jest.fn();
    await autoDispatchReadyTickets(S, { dispatch, env: ON });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing while the kill switch is armed, or when the config cannot be read', async () => {
    const dispatch = jest.fn();
    killSwitch = true;
    await autoDispatchReadyTickets(S, { dispatch, env: ON });
    killSwitch = null;
    await autoDispatchReadyTickets(S, { dispatch, env: ON });
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('/feedback_tickets'))).toBe(false);
  });

  it('respects the per-pass cap', async () => {
    tickets = [ticket('t-11'), ticket('t-12'), ticket('t-13'), ticket('t-14')];
    const dispatch = jest.fn().mockResolvedValue({ ok: true });
    const r = await autoDispatchReadyTickets(S, { dispatch, env: { ...ON, FEEDBACK_AUTO_DISPATCH_PER_TICK: '3' } as any });
    expect(r.dispatched).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('records a refusal, emits auto_dispatch_blocked, and stops after the attempt limit', async () => {
    tickets = [ticket('t-21', { linked_vtid: 'VTID-04601' })];
    const dispatch = jest.fn().mockResolvedValue({ ok: false, error: 'bridge failed: kill_switch', violations: [{ code: 'kill_switch_engaged', message: 'armed' }] });
    const r = await autoDispatchReadyTickets(S, { dispatch, env: ON });
    expect(r.failed).toBe(1);
    const last = calls.filter((c) => c.method === 'PATCH').pop()!;
    expect(last.body.classifier_meta).toMatchObject({ auto_dispatch_attempts: 1, auto_dispatch_claimed_at: null });
    expect(last.body.classifier_meta.auto_dispatch_last_error).toMatch(/kill_switch/);
    const ev = mockEmit.mock.calls[0][0];
    expect(ev.type).toBe('feedback.ticket.auto_dispatch_blocked');
    expect(ev.vtid).toBe('VTID-04601');
    expect(ev.payload).toMatchObject({ ticket_number: 'FB-2026-09-000021', violation_codes: ['kill_switch_engaged'] });

    dispatch.mockClear();
    tickets = [ticket('t-21', { classifier_meta: { auto_dispatch_attempts: MAX_AUTO_DISPATCH_ATTEMPTS } })];
    const r2 = await autoDispatchReadyTickets(S, { dispatch, env: ON });
    expect(r2.skipped).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips a ticket another gateway just claimed', async () => {
    tickets = [ticket('t-31', { classifier_meta: { auto_dispatch_claimed_at: new Date().toISOString() } })];
    const dispatch = jest.fn();
    const r = await autoDispatchReadyTickets(S, { dispatch, env: ON });
    expect(r.skipped).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('migration: auto-triage covers bug + ux_issue of every priority', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const sql = fs.readFileSync(path.resolve(__dirname,
    '../../../supabase/migrations/20260923130000_vtid_04333_auto_triage_all_bug_priorities.sql'), 'utf8');

  it('replaces the p3-only bug branch with bug + ux_issue, no priority filter', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.auto_triage_pending_feedback_tickets\(\)/);
    expect(sql).toMatch(/ELSIF r\.kind IN \('bug', 'ux_issue'\) THEN/);
    expect(sql).not.toMatch(/r\.priority = 'p3'/);
  });

  it('still writes a spec the drafter recognises as a placeholder (never dispatched as-is)', () => {
    expect(sql).toContain("spec_md = '# Devon auto-draft spec (placeholder)'");
    const { isPlaceholderSpec } = jest.requireActual('../src/services/feedback-spec-drafter');
    expect(isPlaceholderSpec('# Devon auto-draft spec (placeholder)\n## User report\nx')).toBe(true);
  });

  it('keeps the human-only support queue exclusion and the other branches', () => {
    expect(sql).toContain("AND COALESCE(surface, '') <> 'support'");
    expect(sql).toContain("IF r.kind = 'support_question'");
    expect(sql).toContain("ELSIF r.kind = 'account_issue'");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.auto_triage_pending_feedback_tickets() TO service_role;');
  });
});

describe('draftPlaceholderSpecsTick → auto-dispatch', () => {
  it('dispatches the ticket it just drafted in the same pass', async () => {
    const drafting = [{ id: 't-41', ticket_number: 'FB-2026-09-000041', kind: 'bug', status: 'spec_ready', spec_md: PLACEHOLDER,
      raw_transcript: 'x', intake_messages: null, structured_fields: null, classifier_meta: {}, screen_path: null,
      app_version: null, vitana_id: null, priority: 'p1', supervisor_notes: null }];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.includes('/dev_autopilot_config')) return { ok: true, json: async () => [{ kill_switch: false }] } as any;
      if (method === 'PATCH') return { ok: true, json: async () => [{ id: 't-41' }] } as any;
      if (url.includes('spec_md=ilike.*placeholder*')) return { ok: true, json: async () => drafting } as any;
      if (url.includes('id=in.(t-41)')) return { ok: true, json: async () => [ticket('t-41')] } as any;
      return { ok: true, json: async () => [] } as any;
    });
    const draft = jest.fn().mockResolvedValue({ markdown: REAL_SPEC, provider: 'llm' });
    const dispatch = jest.fn().mockResolvedValue({ ok: true, vtid: 'VTID-04602' });
    const r = await draftPlaceholderSpecsTick(S, { draft, dispatch, force: true, env: ON });
    expect(r).toMatchObject({ drafted: 1, dispatched: 1 });
    expect(dispatch).toHaveBeenCalledWith('t-41', 'auto-dispatch');
  });

  it('with the flag off, the drafter behaves exactly as before', async () => {
    const dispatch = jest.fn();
    const r = await draftPlaceholderSpecsTick(S, { draft: jest.fn(), dispatch, force: true, env: {} as any });
    expect(r.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('/dev_autopilot_config'))).toBe(false);
  });
});
