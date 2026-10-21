/**
 * BOOTSTRAP-ORB-UNREAD-MESSAGES-NAV — `tool_navigate_to_screen` threads an
 * optional `keep_orb_open` flag into the dispatched `orb_directive`, so a
 * deterministic greeting-effect navigate (see routes/orb-live.ts's
 * `_renderSync`) can tell the client widget to stay open instead of the
 * normal hide-then-navigate teardown. The flag is opt-in and absent by
 * default — every existing LLM tool-call navigate path is unaffected.
 */

import { tool_navigate_to_screen } from '../../src/services/orb-tools-shared';

const sbStub: any = { from: () => ({ insert: () => ({}) }) };

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

describe('tool_navigate_to_screen — keep_orb_open threading', () => {
  test('omits keep_orb_open from the directive by default (existing tool-call behavior unchanged)', async () => {
    const r: any = await tool_navigate_to_screen({ screen_id: 'INBOX.OVERVIEW' }, authedId, sbStub);
    expect(r.ok).toBe(true);
    expect(r.result.directive).toBeDefined();
    expect(r.result.directive.keep_orb_open).toBeUndefined();
  });

  test('forwards keep_orb_open:true onto the directive when the caller asks for it', async () => {
    const r: any = await tool_navigate_to_screen(
      { screen_id: 'INBOX.OVERVIEW', reason: 'unread_messages', keep_orb_open: true },
      authedId,
      sbStub,
    );
    expect(r.ok).toBe(true);
    expect(r.result.directive.keep_orb_open).toBe(true);
    expect(r.result.directive.screen_id).toBe('INBOX.OVERVIEW');
    expect(r.result.directive.reason).toBe('unread_messages');
  });

  test('a truthy-but-not-strictly-true keep_orb_open is ignored (no accidental coercion)', async () => {
    const r: any = await tool_navigate_to_screen(
      { screen_id: 'INBOX.OVERVIEW', keep_orb_open: 'yes' as any },
      authedId,
      sbStub,
    );
    expect(r.result.directive.keep_orb_open).toBeUndefined();
  });
});
