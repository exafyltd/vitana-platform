/**
 * NAV_CONTINUATION_BIND — unit tests for the offer_action tool (invariant #10,
 * PRODUCE side). Vitana records the exact action she proposes as pending_cta;
 * the acceptance gate consumes it on "Ja". Tests the handler + registry wiring.
 */
import {
  tool_offer_action,
  ORB_TOOL_NAMES,
  type OrbToolIdentity,
} from '../src/services/orb-tools-shared';

const ID: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };

/** Minimal Supabase stub capturing the orb_session_state upsert row. */
function makeSbStub() {
  const upserts: any[] = [];
  const sb: any = {
    from: (_table: string) => ({
      upsert: (row: any) => {
        upserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { sb, upserts };
}

const FLAG = 'NAV_CONTINUATION_BIND';
afterEach(() => {
  delete process.env[FLAG];
});

test('offer_action is registered in the shared tool registry', () => {
  expect(ORB_TOOL_NAMES).toContain('offer_action');
});

test('flag ON: stores the exact offered action as pending_cta', async () => {
  process.env[FLAG] = 'true';
  const { sb, upserts } = makeSbStub();
  const r: any = await tool_offer_action(
    { tool: 'navigate_to_screen', payload: { screen_id: 'AUTOPILOT.MY_JOURNEY' } },
    ID,
    sb,
  );
  expect(r.ok).toBe(true);
  expect(r.result.stored).toBe(true);
  expect(upserts).toHaveLength(1);
  expect(upserts[0].key).toBe('pending_cta');
  expect(upserts[0].user_id).toBe('u-1');
  expect(upserts[0].value.tool).toBe('navigate_to_screen');
  expect(upserts[0].value.payload).toEqual({ screen_id: 'AUTOPILOT.MY_JOURNEY' });
  expect(typeof upserts[0].value.offered_at).toBe('string');
});

test('flag OFF: inert success, nothing written', async () => {
  const { sb, upserts } = makeSbStub();
  const r: any = await tool_offer_action({ tool: 'navigate_to_screen' }, ID, sb);
  expect(r.ok).toBe(true);
  expect(r.result.stored).toBe(false);
  expect(upserts).toHaveLength(0);
});

test('rejects an unknown / non-dispatchable tool', async () => {
  process.env[FLAG] = 'true';
  const { sb, upserts } = makeSbStub();
  const r: any = await tool_offer_action({ tool: 'definitely_not_a_tool' }, ID, sb);
  expect(r.ok).toBe(false);
  expect(upserts).toHaveLength(0);
});

test('rejects self-referential offer_action', async () => {
  process.env[FLAG] = 'true';
  const { sb } = makeSbStub();
  const r: any = await tool_offer_action({ tool: 'offer_action' }, ID, sb);
  expect(r.ok).toBe(false);
});

test('rejects a missing tool arg', async () => {
  process.env[FLAG] = 'true';
  const { sb } = makeSbStub();
  const r: any = await tool_offer_action({}, ID, sb);
  expect(r.ok).toBe(false);
});

test('clamps ttl_minutes into 1..30 (default 5 when out of range)', async () => {
  process.env[FLAG] = 'true';
  const { sb, upserts } = makeSbStub();
  // 999 is out of range → handler falls back to 5 min; assert the row expires
  // ~5 min out, not ~999.
  const before = Date.now();
  await tool_offer_action({ tool: 'navigate', ttl_minutes: 999 }, ID, sb);
  const expiresAt = Date.parse(upserts[0].expires_at);
  const minutesOut = (expiresAt - before) / 60_000;
  expect(minutesOut).toBeGreaterThan(4);
  expect(minutesOut).toBeLessThan(6);
});
