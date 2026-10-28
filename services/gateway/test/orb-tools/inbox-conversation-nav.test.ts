/**
 * BOOTSTRAP-ORB-INBOX-CONVERSATION-NAV — navigate_to_screen can now open ONE
 * specific DM thread (INBOX.CONVERSATION, /inbox/u/:recipient_id) or group
 * chat (INBOX.GROUP, /inbox/g/:chat_group_id), not just the general
 * INBOX.OVERVIEW. Both frontend routes already exist and are already used by
 * push-notification deep links (notification-types.ts, messaging-depth-tools.ts,
 * orb-tools-shared.ts's send_chat_message) — this only adds the missing
 * navigation-catalog entries so the ORB's navigate_to_screen tool can reach
 * them too. Root cause of the live report: Vitana would propose to open "the
 * message" and then have no screen_id to actually call, because only the
 * general inbox existed in the catalog.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { tool_navigate_to_screen } from '../../src/services/orb-tools-shared';

const sbStub: any = {
  from: () => ({ insert: () => ({}) }),
};

const authedId = {
  user_id: 'u-1',
  tenant_id: 't-1',
  vitana_id: 'viewer',
  role: 'community',
  lang: 'en',
  session_id: 's-1',
  is_anonymous: false,
  is_mobile: false,
} as any;

describe('navigate_to_screen — INBOX.CONVERSATION (specific DM thread)', () => {
  test('resolves to /inbox/u/<recipient_id> when a real recipient_id is given', async () => {
    const r: any = await tool_navigate_to_screen(
      { screen_id: 'INBOX.CONVERSATION', recipient_id: 'sender-42' },
      authedId,
      sbStub,
    );
    expect(r.ok).toBe(true);
    expect(r.result.route).toBe('/inbox/u/sender-42');
    expect(r.result.screen_id).toBe('INBOX.CONVERSATION');
  });

  test('errors with a clear missing-param message when recipient_id is absent', async () => {
    const r: any = await tool_navigate_to_screen({ screen_id: 'INBOX.CONVERSATION' }, authedId, sbStub);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recipient_id/);
  });
});

describe('navigate_to_screen — INBOX.GROUP (specific group chat)', () => {
  test('resolves to /inbox/g/<chat_group_id> when a real chat_group_id is given', async () => {
    const r: any = await tool_navigate_to_screen(
      { screen_id: 'INBOX.GROUP', chat_group_id: 'group-7' },
      authedId,
      sbStub,
    );
    expect(r.ok).toBe(true);
    expect(r.result.route).toBe('/inbox/g/group-7');
    expect(r.result.screen_id).toBe('INBOX.GROUP');
  });

  test('errors with a clear missing-param message when chat_group_id is absent', async () => {
    const r: any = await tool_navigate_to_screen({ screen_id: 'INBOX.GROUP' }, authedId, sbStub);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/chat_group_id/);
  });
});

describe('navigate_to_screen — INBOX.OVERVIEW is unaffected', () => {
  test('still resolves with no params (the general-inbox path used before this change)', async () => {
    const r: any = await tool_navigate_to_screen({ screen_id: 'INBOX.OVERVIEW' }, authedId, sbStub);
    expect(r.ok).toBe(true);
    expect(r.result.route).toBe('/inbox');
  });
});
