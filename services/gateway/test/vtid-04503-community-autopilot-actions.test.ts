/**
 * VTID-04503 (Community Autopilot CA-3): typed actions, confirm-then-execute,
 * one agent_runs row per execution, and confirm_pending_action.
 */
process.env.NODE_ENV = 'test';

jest.mock('../src/services/reminders-service', () => ({
  createReminder: jest.fn(async (_sb: unknown, input: { action_text: string }) => ({ id: 'rem-1', ...input })),
}));

const mockDispatch = jest.fn();
jest.mock('../src/services/orb-tools-shared', () => ({
  dispatchOrbTool: (...a: unknown[]) => mockDispatch(...a),
}));

import { createReminder } from '../src/services/reminders-service';
import {
  ACTION_REGISTRY,
  checkActionPolicy,
  executeRecommendationAction,
  idempotencyKeyFor,
  parseAction,
  riskOf,
  type ActionContext,
} from '../src/services/community-autopilot/action-registry';
import { tool_confirm_pending_action } from '../src/services/orb-tools/community-autopilot-tools';

const USER = 'aaaa1111-1111-4111-8111-111111111111';
const TENANT = 'bbbb2222-2222-4222-8222-222222222222';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: USER,
  tenantId: TENANT,
  recommendationId: 'rec-1',
  recommendationTitle: 'Hydration check-in',
  channel: 'app',
  ...over,
});

/** In-memory agent_runs + orb_session_state. */
function memSb(opts: { pendingCta?: unknown } = {}) {
  const runs: Array<Record<string, any>> = [];
  const state = new Map<string, any>();
  if (opts.pendingCta) state.set(`${USER}:pending_cta`, { value: opts.pendingCta, expires_at: new Date(Date.now() + 60_000).toISOString() });
  const sb: any = {
    runs,
    state,
    from(table: string) {
      if (table === 'agent_runs') {
        return {
          insert: async (row: Record<string, any>) => {
            if (runs.some((r) => r.idempotency_key === row.idempotency_key)) {
              return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
            runs.push({ ...row });
            return { error: null };
          },
          select: () => ({
            eq: (_c: string, key: string) => ({
              limit: async () => ({ data: runs.filter((r) => r.idempotency_key === key), error: null }),
            }),
          }),
          update: (patch: Record<string, any>) => {
            const filters: Array<[string, any]> = [];
            const chain: any = {
              eq: (c: string, v: any) => { filters.push([c, v]); return chain; },
              select: async () => {
                const hit = runs.filter((r) => filters.every(([c, v]) => r[c] === v));
                hit.forEach((r) => Object.assign(r, patch));
                return { data: hit.map((r) => ({ id: r.id })), error: null };
              },
              then: (res: any, rej: any) => {
                runs.filter((r) => filters.every(([c, v]) => r[c] === v)).forEach((r) => Object.assign(r, patch));
                return Promise.resolve({ error: null }).then(res, rej);
              },
            };
            return chain;
          },
        };
      }
      if (table === 'orb_session_state') {
        return {
          select: () => ({ eq: (_c: string, u: string) => ({ eq: (_c2: string, k: string) => ({
            maybeSingle: async () => ({ data: state.get(`${u}:${k}`) ?? null, error: null }),
          }) }) }),
          delete: () => ({ eq: (_c: string, u: string) => ({ eq: async (_c2: string, k: string) => { state.delete(`${u}:${k}`); return { error: null }; } }) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

beforeEach(() => {
  mockDispatch.mockReset();
  (createReminder as jest.Mock).mockClear();
});

describe('registry + policy', () => {
  test('only known kinds parse; malformed rows are informational', () => {
    expect(parseAction({ kind: 'log_water', params: { amount_ml: 250 } })).toEqual({ kind: 'log_water', params: { amount_ml: 250 } });
    expect(parseAction({ kind: 'drop_database' })).toBeNull();
    expect(parseAction(null)).toBeNull();
    expect(parseAction('log_water')).toBeNull();
  });

  test('the registry decides risk, never the row', () => {
    expect(riskOf({ kind: 'join_group', risk: 'low' } as any)).toBe('medium');
    expect(riskOf({ kind: 'log_water' })).toBe('low');
  });

  test('a slot-booking template gets a reminder at its slot; others get nothing', () => {
    const { defaultActionForTemplate } = require('../src/services/community-autopilot/action-registry');
    expect(defaultActionForTemplate(true)).toEqual({ kind: 'set_reminder', params: {} });
    expect(defaultActionForTemplate(false)).toBeNull();
  });

  test('no high-risk kind exists in the community lane', () => {
    for (const spec of Object.values(ACTION_REGISTRY)) expect(['low', 'medium']).toContain(spec.risk);
  });

  test('low risk runs on a spoken yes; medium needs a read-back on voice but not in the app', () => {
    expect(checkActionPolicy({ kind: 'log_water', params: { amount_ml: 250 } }, ctx({ channel: 'voice' }))).toBeNull();
    const voice = checkActionPolicy({ kind: 'join_group', params: { group_id: 'g1', group_name: 'Runners' } }, ctx({ channel: 'voice' }));
    expect(voice).toMatchObject({ status: 'needs_confirmation' });
    expect((voice as any).readback).toContain('Runners');
    expect(checkActionPolicy({ kind: 'join_group', params: { group_id: 'g1' } }, ctx({ channel: 'voice', confirmed: true }))).toBeNull();
    expect(checkActionPolicy({ kind: 'join_group', params: { group_id: 'g1' } }, ctx({ channel: 'app' }))).toBeNull();
  });

  test('invalid params never run', () => {
    expect(checkActionPolicy({ kind: 'log_water', params: { amount_ml: 99999 } }, ctx())).toMatchObject({ status: 'invalid' });
    expect(checkActionPolicy({ kind: 'rsvp_event', params: {} }, ctx())).toMatchObject({ status: 'invalid' });
  });
});

describe('executeRecommendationAction', () => {
  test('runs an ORB-tool kind through the shared handler and records one agent_runs row', async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { value: 250 }, text: 'Logged 250 ml' });
    const sb = memSb();
    const out = await executeRecommendationAction(sb, { kind: 'log_water', params: { amount_ml: 250 } }, ctx());
    expect(out).toMatchObject({ status: 'executed', kind: 'log_water' });
    expect(mockDispatch).toHaveBeenCalledWith('log_water', { amount_ml: 250 },
      expect.objectContaining({ user_id: USER, tenant_id: TENANT, role: 'community' }), sb);
    expect(sb.runs).toHaveLength(1);
    expect(sb.runs[0]).toMatchObject({
      plane: 'community_autopilot', status: 'succeeded', tier: 'commit', user_id: USER,
      idempotency_key: idempotencyKeyFor('rec-1', 'log_water'),
    });
  });

  test('a second execution of the same action never runs twice', async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: {} });
    const sb = memSb();
    await executeRecommendationAction(sb, { kind: 'log_water', params: { amount_ml: 250 } }, ctx());
    const again = await executeRecommendationAction(sb, { kind: 'log_water', params: { amount_ml: 250 } }, ctx());
    expect(again.status).toBe('already_executed');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('a failed attempt is recorded and may be retried', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: false, error: 'db down' }).mockResolvedValueOnce({ ok: true, result: {} });
    const sb = memSb();
    const first = await executeRecommendationAction(sb, { kind: 'log_water', params: { amount_ml: 250 } }, ctx());
    expect(first).toMatchObject({ status: 'failed', error: 'db down' });
    expect(sb.runs[0].status).toBe('failed');
    const retry = await executeRecommendationAction(sb, { kind: 'log_water', params: { amount_ml: 250 } }, ctx());
    expect(retry.status).toBe('executed');
    expect(sb.runs).toHaveLength(1);
    expect(sb.runs[0].status).toBe('succeeded');
  });

  test('set_reminder uses the reminders service at the booked slot', async () => {
    const sb = memSb();
    const out = await executeRecommendationAction(sb, { kind: 'set_reminder', params: {} },
      ctx({ slotStartIso: '2030-01-01T08:00:00.000Z', calendarEventId: 'ev-1' }));
    expect(out.status).toBe('executed');
    expect(createReminder).toHaveBeenCalledWith(sb, expect.objectContaining({
      user_id: USER, tenant_id: TENANT, scheduled_for_iso: '2030-01-01T08:00:00.000Z',
      calendar_event_id: 'ev-1', action_text: 'Hydration check-in',
    }));
  });

  test('client kinds navigate without a server run', async () => {
    const sb = memSb();
    const out = await executeRecommendationAction(sb, { kind: 'open_screen', params: { route: '/discover' } }, ctx());
    expect(out).toEqual({ status: 'navigate', kind: 'open_screen', route: '/discover' });
    expect(sb.runs).toHaveLength(0);
  });

  test('a voice medium-risk action without confirmation writes nothing', async () => {
    const sb = memSb();
    const out = await executeRecommendationAction(sb, { kind: 'join_group', params: { group_id: 'g1' } }, ctx({ channel: 'voice' }));
    expect(out.status).toBe('needs_confirmation');
    expect(sb.runs).toHaveLength(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('confirm_pending_action', () => {
  const ID = { user_id: USER, tenant_id: TENANT, role: 'community' } as any;

  test('runs exactly the stored offer and consumes it', async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { title: 'Walk' } });
    const sb = memSb({ pendingCta: { tool: 'activate_recommendation', payload: { id: 'rec-9' }, offer_id: 'o1' } });
    const r = await tool_confirm_pending_action({}, ID, sb);
    expect(r.ok).toBe(true);
    expect(mockDispatch).toHaveBeenCalledWith('activate_recommendation', { id: 'rec-9' }, ID, sb);
    expect(sb.state.size).toBe(0);
  });

  test('a read-back keeps the offer open; confirm=true is passed through', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, result: { awaiting_confirmation: true } });
    const sb = memSb({ pendingCta: { tool: 'activate_recommendation', payload: { id: 'rec-9' } } });
    await tool_confirm_pending_action({}, ID, sb);
    expect(sb.state.size).toBe(1);
    mockDispatch.mockResolvedValueOnce({ ok: true, result: {} });
    await tool_confirm_pending_action({ confirm: true }, ID, sb);
    expect(mockDispatch).toHaveBeenLastCalledWith('activate_recommendation', { id: 'rec-9', confirm: true }, ID, sb);
    expect(sb.state.size).toBe(0);
  });

  test('no open offer → nothing runs', async () => {
    const r = await tool_confirm_pending_action({}, ID, memSb());
    expect(r.ok).toBe(true);
    expect((r as any).result.reason).toBe('no_pending_offer');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('an offer that reaches other people is not run on a spoken yes', async () => {
    const sb = memSb({ pendingCta: { tool: 'send_chat_message', payload: { to: 'x', text: 'hi' } } });
    const r = await tool_confirm_pending_action({}, ID, sb);
    expect((r as any).result.reason).toBe('not_voice_confirmable');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a stale offer_id is refused', async () => {
    const sb = memSb({ pendingCta: { tool: 'activate_recommendation', payload: { id: 'rec-9' }, offer_id: 'o2' } });
    const r = await tool_confirm_pending_action({ offer_id: 'o1' }, ID, sb);
    expect((r as any).result.reason).toBe('offer_changed');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('anonymous is refused', async () => {
    const r = await tool_confirm_pending_action({}, { ...ID, user_id: '' }, memSb());
    expect(r.ok).toBe(false);
  });
});
