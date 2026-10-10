/**
 * VTID-04918 — Vitana assistant parity for the calendar.
 *
 * Pins: one implementation of create / share to feed / invite in the shared
 * ORB_TOOL_REGISTRY; the shared guard (confirmed + not over) holds there for
 * every path; nothing is written, posted or sent before the member confirmed;
 * share and invite reuse the Phase 2/3 services (never a second
 * implementation); reschedule never moves into the past; the live session
 * adds memberHasSpoken; text chat and the LiveKit agent reach the same
 * handlers; the stale role-registry names are gone. No network, no DB.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';

jest.mock('../src/services/calendar-service', () => ({
  createCalendarEvent: jest.fn(),
  checkConflicts: jest.fn(async () => []),
  getOwnCalendarEvent: jest.fn(),
  rescheduleEvent: jest.fn(),
  softDeleteEvent: jest.fn(),
  markEventCompleted: jest.fn(),
  getSupabaseConfig: jest.fn(() => null),
  headers: jest.fn(() => ({})),
}));
jest.mock('../src/services/calendar-producers', () => ({ completeSourceForCalendarEvent: jest.fn() }));
jest.mock('../src/services/calendar-share', () => {
  const actual = jest.requireActual('../src/services/calendar-share');
  return { ...actual, shareCalendarEntryToFeed: jest.fn() };
});
jest.mock('../src/services/calendar-invite', () => {
  const actual = jest.requireActual('../src/services/calendar-invite');
  return { ...actual, buildInviteFromEntry: jest.fn() };
});
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => undefined) }));
jest.mock('../src/services/voice-message-guard', () => ({ checkVoiceSendQuota: jest.fn(async () => ({ allowed: true, remaining: 4 })) }));
jest.mock('../src/services/notification-service', () => ({ notifyUser: jest.fn(async () => ({ pushed: 1, inapp: true })) }));

import { createCalendarEvent, getOwnCalendarEvent, rescheduleEvent } from '../src/services/calendar-service';
import { shareCalendarEntryToFeed } from '../src/services/calendar-share';
import { buildInviteFromEntry } from '../src/services/calendar-invite';
import { checkVoiceSendQuota } from '../src/services/voice-message-guard';
import { notifyUser } from '../src/services/notification-service';
import { checkCalendarWriteRequest, checkVoiceCalendarWrite } from '../src/orb/live/tools/calendar-write-guard';
import {
  CALENDAR_SOCIAL_TOOL_DECLARATIONS,
  CALENDAR_SOCIAL_TOOL_HANDLERS,
  CALENDAR_SOCIAL_WRITE_TOOLS,
  CALENDAR_TEXT_TOOL_NAMES,
  calendarTextToolDeclarations,
  textCalendarConfirmation,
  tool_create_calendar_event,
  tool_invite_to_calendar_entry,
  tool_share_calendar_entry_to_feed,
} from '../src/services/orb-tools/calendar-social-tools';
import { CALENDAR_MGMT_TOOL_DECLARATIONS, tool_reschedule_event } from '../src/services/orb-tools/calendar-management-tools';
import { ROLE_PROFILES } from '../src/services/intelligence/assistant-role-registry';

const ME = { user_id: 'me-0000', tenant_id: 'tenant-1', role: 'community', session_id: 'sess-1' };
const PEER = '11111111-2222-4333-8444-555555555555';
const GCE = '99999999-2222-4333-8444-555555555555';
const NOW = Date.now();
const FUTURE = new Date(NOW + 2 * 86_400_000).toISOString();
const FUTURE_END = new Date(NOW + 2 * 86_400_000 + 3_600_000).toISOString();
const PAST = new Date(NOW - 2 * 86_400_000).toISOString();

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1', user_id: ME.user_id, title: 'Sunset yoga', start_time: FUTURE, end_time: FUTURE_END, location: 'Seepark',
    status: 'confirmed', source_type: 'community_rsvp', source_ref_type: 'community_event', source_ref_id: GCE, rrule: null,
    ...over,
  };
}

/** Table-aware supabase fake: reads resolve with per-table rows, inserts are recorded. */
function fakeSb(tables: Record<string, unknown[]> = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const from = jest.fn((table: string) => {
    const rows = tables[table] ?? [];
    const b: any = {};
    for (const m of ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'ilike', 'order', 'limit', 'is']) b[m] = jest.fn(() => b);
    b.maybeSingle = jest.fn(async () => ({ data: rows[0] ?? null, error: null }));
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    b.insert = jest.fn((row: Record<string, unknown>) => {
      inserts.push({ table, row });
      const chain: any = { select: () => chain, single: async () => ({ data: { id: 'msg-1' }, error: null }) };
      return chain;
    });
    return b;
  });
  return { sb: { from } as unknown as SupabaseClient, inserts };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getOwnCalendarEvent as jest.Mock).mockResolvedValue(entry());
});

describe('the shared guard (every assistant path)', () => {
  it('needs an explicit confirmation', () => {
    expect(checkCalendarWriteRequest({ confirmed: undefined, startTime: FUTURE, nowMs: NOW })).toMatch(/^STATUS: needs_confirmation/);
    expect(checkCalendarWriteRequest({ confirmed: 'yes', startTime: FUTURE, nowMs: NOW })).toMatch(/^STATUS: needs_confirmation/);
    expect(checkCalendarWriteRequest({ confirmed: true, startTime: FUTURE, nowMs: NOW })).toBeNull();
  });

  it('refuses a time that has passed, but an event still running is open', () => {
    expect(checkCalendarWriteRequest({ confirmed: true, startTime: PAST, nowMs: NOW })).toMatch(/in the past/);
    const startedHourAgo = new Date(NOW - 3_600_000).toISOString();
    const endsInHour = new Date(NOW + 3_600_000).toISOString();
    expect(checkCalendarWriteRequest({ confirmed: true, startTime: startedHourAgo, endTime: endsInHour, nowMs: NOW })).toBeNull();
  });

  it('the live session still refuses before the member has spoken', () => {
    expect(checkVoiceCalendarWrite({ memberHasSpoken: false, confirmed: true, startTime: FUTURE, nowMs: NOW })).toMatch(/has not asked/);
    expect(checkVoiceCalendarWrite({ memberHasSpoken: true, confirmed: true, startTime: FUTURE, nowMs: NOW })).toBeNull();
  });
});

describe('create_calendar_event (shared handler)', () => {
  it('creates nothing until confirmed, and never in the past', async () => {
    const preview = await tool_create_calendar_event({ title: 'Dentist', start_time: FUTURE }, ME);
    expect(preview).toMatchObject({ ok: true, result: { stage: 'awaiting_confirmation', created: false } });
    const past = await tool_create_calendar_event({ title: 'Dentist', start_time: PAST, confirmed: true }, ME);
    expect((past as { text: string }).text).toMatch(/in the past/);
    expect(createCalendarEvent).not.toHaveBeenCalled();
  });

  it('writes an assistant entry for the member once confirmed', async () => {
    (createCalendarEvent as jest.Mock).mockResolvedValue({ id: 'new-1', title: 'Dentist', event_type: 'personal' });
    const r = await tool_create_calendar_event({ title: 'Dentist', when_iso: FUTURE, duration_min: 30, confirmed: true }, ME);
    expect(r).toMatchObject({ ok: true, result: { created: true, event_id: 'new-1' } });
    const [userId, input] = (createCalendarEvent as jest.Mock).mock.calls[0];
    expect(userId).toBe(ME.user_id);
    expect(input).toMatchObject({ title: 'Dentist', source_type: 'assistant', role_context: 'community', status: 'confirmed' });
    expect(Date.parse(input.end_time) - Date.parse(input.start_time)).toBe(30 * 60_000);
  });
});

describe('share_calendar_entry_to_feed (Phase 2 service, assistant entry point)', () => {
  it('posts nothing until confirmed, and the preview carries the text to read back', async () => {
    const { sb } = fakeSb({ calendar_events: [entry()] });
    const r = await tool_share_calendar_entry_to_feed({ entry_id: 'ev-1', text: 'Ich bin dabei!' }, ME, sb);
    expect(r).toMatchObject({ ok: true, result: { stage: 'awaiting_confirmation', entry_id: 'ev-1', text: 'Ich bin dabei!', is_public: true } });
    expect(shareCalendarEntryToFeed).not.toHaveBeenCalled();
  });

  it('a private entry is never shared', async () => {
    (getOwnCalendarEvent as jest.Mock).mockResolvedValue(entry({ source_type: 'manual', source_ref_type: null, source_ref_id: null }));
    const { sb } = fakeSb({ calendar_events: [entry()] });
    const r = await tool_share_calendar_entry_to_feed({ entry_id: 'ev-1', confirmed: true }, ME, sb);
    expect((r as { text: string }).text).toMatch(/^STATUS: not_shareable/);
    expect(shareCalendarEntryToFeed).not.toHaveBeenCalled();
  });

  it('confirmed: the same service the app uses shares it; its refusals are named', async () => {
    (shareCalendarEntryToFeed as jest.Mock).mockResolvedValueOnce({ ok: true, post_id: 'post-1', ref: { ref_type: 'community_event', ref_id: GCE } });
    const { sb } = fakeSb({ calendar_events: [entry()] });
    const r = await tool_share_calendar_entry_to_feed({ entry_id: 'ev-1', text: 'Kommst du mit?', is_public: true, confirmed: true }, ME, sb);
    expect(r).toMatchObject({ ok: true, result: { shared: true, post_id: 'post-1' } });
    expect(shareCalendarEntryToFeed).toHaveBeenCalledWith(ME.user_id, expect.objectContaining({ id: 'ev-1' }), { text: 'Kommst du mit?', is_public: true });

    (shareCalendarEntryToFeed as jest.Mock).mockResolvedValueOnce({ ok: false, status: 409, error: 'ALREADY_SHARED', post_id: 'post-1' });
    const again = await tool_share_calendar_entry_to_feed({ entry_id: 'ev-1', is_public: true, confirmed: true }, ME, sb);
    expect((again as { text: string }).text).toMatch(/^STATUS: already_shared/);
  });

  it('a post approved as private stays private: the confirmation must carry the visibility', async () => {
    const { sb } = fakeSb({ calendar_events: [entry()] });
    const preview = await tool_share_calendar_entry_to_feed({ entry_id: 'ev-1', text: 'Nur für mich', is_public: false }, ME, sb);
    expect(preview).toMatchObject({ ok: true, result: { stage: 'awaiting_confirmation', is_public: false } });
    const missing = await tool_share_calendar_entry_to_feed({ entry_id: 'ev-1', text: 'Nur für mich', confirmed: true }, ME, sb);
    expect((missing as { text: string }).text).toMatch(/^STATUS: needs_visibility/);
    expect(shareCalendarEntryToFeed).not.toHaveBeenCalled();
    (shareCalendarEntryToFeed as jest.Mock).mockResolvedValueOnce({ ok: true, post_id: 'post-2', ref: { ref_type: 'community_event', ref_id: GCE } });
    await tool_share_calendar_entry_to_feed({ entry_id: 'ev-1', text: 'Nur für mich', is_public: false, confirmed: true }, ME, sb);
    expect(shareCalendarEntryToFeed).toHaveBeenCalledWith(ME.user_id, expect.objectContaining({ id: 'ev-1' }), { text: 'Nur für mich', is_public: false });
  });
});

describe('invite_to_calendar_entry (Phase 3 card, assistant entry point)', () => {
  const card = { kind: 'calendar_invite', v: 2, ref_type: 'community_event', ref_id: GCE, title: 'Sunset yoga', start_time: FUTURE, end_time: FUTURE_END, location: 'Seepark' };
  const peerRow = { user_id: PEER, display_name: 'Ana', vitana_id: 'ana1', tenant_id: 'tenant-1' };

  beforeEach(() => {
    (buildInviteFromEntry as jest.Mock).mockResolvedValue({ ok: true, metadata: card, content: '📅 Sunset yoga' });
  });

  it('needs a resolved person, never the member themselves', async () => {
    const { sb } = fakeSb();
    expect(await tool_invite_to_calendar_entry({ entry_id: 'ev-1', recipient_user_id: 'Ana' }, ME, sb)).toMatchObject({ ok: false });
    expect(await tool_invite_to_calendar_entry({ entry_id: 'ev-1', recipient_user_id: ME.user_id }, { ...ME, user_id: PEER }, sb)).toMatchObject({ ok: false });
  });

  it('sends nothing until confirmed', async () => {
    const { sb, inserts } = fakeSb({ calendar_events: [entry()], app_users: [peerRow] });
    const r = await tool_invite_to_calendar_entry({ entry_id: 'ev-1', recipient_user_id: PEER }, ME, sb);
    expect(r).toMatchObject({ ok: true, result: { stage: 'awaiting_confirmation', recipient_name: 'Ana', title: 'Sunset yoga' } });
    expect(inserts).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('an entry the card builder refuses is named and nothing is sent', async () => {
    (buildInviteFromEntry as jest.Mock).mockResolvedValue({ ok: false, status: 409, error: 'NOT_INVITABLE', reason: 'recurring' });
    const { sb, inserts } = fakeSb({ calendar_events: [entry()], app_users: [peerRow] });
    const r = await tool_invite_to_calendar_entry({ entry_id: 'ev-1', recipient_user_id: PEER, confirmed: true }, ME, sb);
    expect((r as { text: string }).text).toMatch(/^STATUS: not_invitable/);
    expect(inserts).toHaveLength(0);
  });

  it('confirmed: the server-built card goes into the direct chat and the person gets the chat push', async () => {
    const { sb, inserts } = fakeSb({ calendar_events: [entry()], app_users: [peerRow] });
    const r = await tool_invite_to_calendar_entry({ entry_id: 'ev-1', recipient_user_id: PEER, confirmed: true }, ME, sb);
    expect(r).toMatchObject({ ok: true, result: { invited: true, message_id: 'msg-1' } });
    expect(buildInviteFromEntry).toHaveBeenCalledWith(ME.user_id, expect.objectContaining({ id: 'ev-1' }));
    const sent = inserts.find((i) => i.table === 'chat_messages')!;
    expect(sent.row).toMatchObject({ sender_id: ME.user_id, receiver_id: PEER, message_type: 'calendar_invite', content: '📅 Sunset yoga', metadata: card, tenant_id: 'tenant-1' });
    expect(checkVoiceSendQuota).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'sess-1', recipient_user_id: PEER }));
    expect(notifyUser).toHaveBeenCalledWith(PEER, 'tenant-1', 'new_chat_message', expect.objectContaining({ data: expect.objectContaining({ url: `/inbox/u/${ME.user_id}` }) }), sb);
  });

  it('the send quota holds', async () => {
    (checkVoiceSendQuota as jest.Mock).mockResolvedValueOnce({ allowed: false, reason: 'cap', remaining: 0 });
    const { sb, inserts } = fakeSb({ calendar_events: [entry()], app_users: [peerRow] });
    const r = await tool_invite_to_calendar_entry({ entry_id: 'ev-1', recipient_user_id: PEER, confirmed: true }, ME, sb);
    expect(r).toMatchObject({ ok: true, result: { rate_limited: true } });
    expect(inserts).toHaveLength(0);
  });
});

describe('reschedule_event never moves into the past', () => {
  it('refuses a past new_start before touching the calendar', async () => {
    const { sb } = fakeSb({ calendar_events: [entry()] });
    const r = await tool_reschedule_event({ event_id: 'ev-1', new_start: PAST }, ME, sb);
    expect(r).toMatchObject({ ok: false });
    expect(rescheduleEvent).not.toHaveBeenCalled();
  });
});

describe('one implementation for every path', () => {
  const gw = path.join(__dirname, '..', 'src');
  const read = (p: string) => fs.readFileSync(path.join(gw, p), 'utf8');

  it('the shared registry carries the three handlers and declares only the two new tools', () => {
    expect(Object.keys(CALENDAR_SOCIAL_TOOL_HANDLERS).sort()).toEqual(['create_calendar_event', 'invite_to_calendar_entry', 'share_calendar_entry_to_feed']);
    expect(CALENDAR_SOCIAL_TOOL_DECLARATIONS.map((d) => d.name)).toEqual(['share_calendar_entry_to_feed', 'invite_to_calendar_entry']);
    const shared = read('services/orb-tools-shared.ts');
    expect(shared).toMatch(/\.\.\.CALENDAR_SOCIAL_TOOL_HANDLERS,/);
    expect(shared).toMatch(/\.\.\.CALENDAR_SOCIAL_TOOL_DECLARATIONS,/);
  });

  it('the live session adds memberHasSpoken for every calendar write tool', () => {
    const live = read('routes/orb-live.ts');
    // every calendar mutation reaching the generic arm, incl. reschedule/cancel/complete (Codex review on #4015)
    expect([...CALENDAR_SOCIAL_WRITE_TOOLS].sort()).toEqual(['add_to_calendar', 'cancel_event', 'complete_event', 'create_calendar_event', 'invite_to_calendar_entry', 'reschedule_event', 'share_calendar_entry_to_feed']);
    // add_to_calendar has its own capability arm; it checks the same list before dispatching
    const capArm = live.slice(live.indexOf("case 'add_to_calendar':"), live.indexOf('BOOTSTRAP-ORB-DELEGATION-ROUTE', live.indexOf("case 'add_to_calendar':")));
    expect(capArm).toMatch(/CALENDAR_SOCIAL_WRITE_TOOLS\.includes\(toolName\)[\s\S]{0,200}memberHasSpoken\(session\)[\s\S]*dispatchOrbToolForVertex\(/);
    expect(live).toMatch(/CALENDAR_SOCIAL_WRITE_TOOLS\.includes\(toolName\)[\s\S]{0,200}memberHasSpoken\(session\)/);
    // the live session's own create_calendar_event arm delegates too (no second implementation)
    const arm = live.slice(live.indexOf("case 'create_calendar_event': {"), live.indexOf('VTID-01270A: Community & Events voice tools'));
    expect(arm).toMatch(/memberHasSpoken\(session\)/);
    expect(arm).toMatch(/dispatchOrbToolForVertex\(\s*'create_calendar_event'/);
    expect(arm).not.toContain('createCalendarEvent(');
  });

  it('text chat offers the five calendar tools and runs them through the shared dispatcher', () => {
    const decls = calendarTextToolDeclarations(CALENDAR_MGMT_TOOL_DECLARATIONS);
    expect(decls.map((d) => d.name).sort()).toEqual([...CALENDAR_TEXT_TOOL_NAMES].sort());
    expect(decls.find((d) => d.name === 'reschedule_event')!.parameters.properties).toHaveProperty('confirmed');
    expect(textCalendarConfirmation('reschedule_event', {})).toMatch(/^STATUS: needs_confirmation/);
    expect(textCalendarConfirmation('reschedule_event', { confirmed: true })).toBeNull();
    expect(textCalendarConfirmation('cancel_event', {})).toBeNull(); // cancel has its own confirm step
    const op = read('services/gemini-operator.ts');
    expect(op).toMatch(/\.\.\.calendarTextToolDeclarations\(CALENDAR_MGMT_TOOL_DECLARATIONS\)/);
    for (const name of CALENDAR_TEXT_TOOL_NAMES) expect(op).toContain(`case '${name}':`);
    expect(op).toMatch(/case 'invite_to_calendar_entry': \{[\s\S]{0,1200}dispatchOrbTool\(/);
  });

  it('the LiveKit agent writes through the shared dispatcher, never the raw calendar route', () => {
    const py = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'orb-agent', 'src', 'orb_agent', 'tools.py'), 'utf8');
    const fn = (name: string) => py.slice(py.indexOf(`async def ${name}(`), py.indexOf('@function_tool', py.indexOf(`async def ${name}(`)));
    for (const name of ['create_calendar_event', 'add_to_calendar', 'get_schedule', 'share_calendar_entry_to_feed', 'invite_to_calendar_entry']) {
      expect(fn(name)).toContain(`_dispatch(context, "${name}"`);
      expect(fn(name)).not.toContain('/api/v1/calendar/events');
    }
    expect(fn('create_calendar_event')).toContain('"confirmed": confirmed');
  });

  it('the community role lists the real calendar tools, not the never-built get_calendar_* names', () => {
    const allow = ROLE_PROFILES.community.tool_allowlist;
    expect(allow).not.toContain('get_calendar_today');
    expect(allow).not.toContain('get_calendar_week');
    for (const t of ['search_calendar', 'create_calendar_event', 'reschedule_event', 'cancel_event', 'share_calendar_entry_to_feed', 'invite_to_calendar_entry']) {
      expect(allow).toContain(t);
    }
  });
});
