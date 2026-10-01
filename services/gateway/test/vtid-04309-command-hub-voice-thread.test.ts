/**
 * VTID-04309 — Command Hub voice turns are recorded into the Operator
 * Console thread, never into the community inbox; the console reads them
 * back; the console sends its thread id with every chat turn.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveOperatorThreadIdForVoice,
  isCommandHubVoiceSession,
  recordCommandHubVoiceTurn,
} from '../src/orb/live/session/command-hub-voice-thread';
import { recordOperatorTurn, listOperatorThreadMessages } from '../src/services/operator-threads';

const THREAD = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const USER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('resolveOperatorThreadIdForVoice', () => {
  it('binds a UUID on the command-hub surface only', () => {
    expect(resolveOperatorThreadIdForVoice(THREAD, '/command-hub/operator')).toBe(THREAD);
    expect(resolveOperatorThreadIdForVoice(THREAD, '/community')).toBeNull();
    expect(resolveOperatorThreadIdForVoice(THREAD, null)).toBeNull();
    expect(resolveOperatorThreadIdForVoice('not-a-uuid', '/command-hub')).toBeNull();
    expect(resolveOperatorThreadIdForVoice(undefined, '/command-hub')).toBeNull();
  });
});

describe('recordCommandHubVoiceTurn', () => {
  const env = process.env.OPERATOR_THREADS_ENABLED;
  beforeEach(() => { process.env.OPERATOR_THREADS_ENABLED = 'true'; });
  afterAll(() => { process.env.OPERATOR_THREADS_ENABLED = env; });

  it('returns false for a community session so the inbox bridge still runs', () => {
    const record = jest.fn();
    expect(recordCommandHubVoiceTurn({ sessionId: 's', current_route: '/home' }, 'hi', 'hello', record as any)).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('records a command-hub turn into the bound thread, marked as voice, and suppresses the inbox', () => {
    const record = jest.fn().mockResolvedValue({ recorded: false, turns: 0 });
    const handled = recordCommandHubVoiceTurn({
      sessionId: 'live-1', current_route: '/command-hub/operator', operator_thread_id: THREAD, turn_count: 3, lang: 'en',
      active_role: 'developer', identity: { user_id: USER, tenant_id: 't1' },
    }, ' start a task to fix the login bug ', 'Queued it.', record as any);
    expect(handled).toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD,
      userText: 'start a task to fix the login bug',
      reply: 'Queued it.',
      identity: { user_id: USER, tenant_id: 't1', role: 'developer' },
      meta: expect.objectContaining({ channel: 'voice', orb_session_id: 'live-1', turn_index: 3 }),
    }));
  });

  it('suppresses the inbox even with no bound thread (developer voice is never a community DM)', () => {
    const record = jest.fn();
    expect(recordCommandHubVoiceTurn({ sessionId: 's', current_route: '/command-hub' }, 'x', 'y', record as any)).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it('isCommandHubVoiceSession follows the route', () => {
    expect(isCommandHubVoiceSession({ current_route: '/command-hub/tasks' })).toBe(true);
    expect(isCommandHubVoiceSession({ current_route: '/admin' })).toBe(false);
  });
});

describe('operator-threads storage', () => {
  let calls: Array<{ url: string; method: string; body: any }> = [];
  let threadRow: any;
  let messageRows: any[];
  beforeEach(() => {
    process.env.OPERATOR_THREADS_ENABLED = 'true';
    process.env.SUPABASE_URL = 'https://sb.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
    calls = [];
    threadRow = { id: THREAD, user_id: USER, turns: 1, summary: null, summary_turns: 0, title: 't' };
    messageRows = [];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const payload = url.includes('/operator_threads?') && method === 'GET' ? [threadRow]
        : url.includes('/operator_messages?') && method === 'GET' ? messageRows : undefined;
      return {
        ok: true,
        status: payload === undefined ? 204 : 200,
        text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
      } as any;
    });
  });

  it('drops the empty user row of a greeting-only voice turn', async () => {
    await recordOperatorTurn({ threadId: THREAD, userText: '', reply: 'Hi, what are we fixing?' });
    const insert = calls.find((c) => c.method === 'POST' && c.url.includes('operator_messages'));
    expect(insert?.body).toHaveLength(1);
    expect(insert?.body[0].role).toBe('assistant');
  });

  it('lists messages of the caller\'s own thread, with the since filter', async () => {
    messageRows = [{ id: 'm1', role: 'user', content: 'hi', tool_name: null, meta: { channel: 'voice' }, created_at: '2026-09-22T10:00:00Z' }];
    const r = await listOperatorThreadMessages(THREAD, { userId: USER, sinceIso: '2026-09-22T09:00:00Z' });
    expect(r).toEqual({ ok: true, messages: messageRows });
    const read = calls.find((c) => c.url.includes('/operator_messages?'));
    expect(read?.url).toContain('created_at=gt.');
    expect(read?.url).toContain('order=created_at.asc');
  });

  it('refuses another user\'s thread as not_found', async () => {
    const r = await listOperatorThreadMessages(THREAD, { userId: 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' });
    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(calls.some((c) => c.url.includes('/operator_messages?'))).toBe(false);
  });
});

describe('Command Hub wiring (source contract)', () => {
  const hub = path.join(__dirname, '../src/frontend/command-hub');
  const app = fs.readFileSync(path.join(hub, 'app.js'), 'utf8');
  const widget = fs.readFileSync(path.join(hub, 'orb-widget.js'), 'utf8');
  const handler = fs.readFileSync(path.join(__dirname, '../src/orb/live/session/upstream-message-handler.ts'), 'utf8');

  it('the console sends its thread id with every chat turn', () => {
    expect(app).toMatch(/threadId: state\.operatorActiveThreadId \|\| undefined,/);
  });

  it('the widget is bound to the console thread and syncs voice turns back', () => {
    expect(app).toMatch(/operator_thread_id: state\.operatorActiveThreadId \|\| ''/);
    expect(app).toMatch(/onTurnComplete: function \(\) \{ syncOperatorVoiceTurns\(\); \}/);
    expect(app).toContain("'/api/v1/operator/threads/' + encodeURIComponent(threadId) + '/messages'");
  });

  it('the widget sends operator_thread_id on session start', () => {
    expect(widget).toContain('if (_s.operatorThreadId) startPayload.operator_thread_id = _s.operatorThreadId;');
  });

  it('both inbox-bridge sites skip command-hub sessions', () => {
    expect(handler.match(/!recordCommandHubVoiceTurn\(session as any, chatBridgeUserText, chatBridgeAssistantText\)/g)).toHaveLength(2);
  });
});
