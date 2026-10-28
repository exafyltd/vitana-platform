/**
 * VTID-04189 (console task 25): a non-UUID identity `user_id` must not fail
 * the whole thread write.
 *
 * `operator_threads.user_id` is a UUID column. Non-standard callers can carry
 * an identity whose `user_id` is not a UUID (a service name, a handle …); the
 * first-turn insert then failed outright and the failure was only swallowed
 * by the generic try/catch, silently no-oping the thread bookkeeping. The
 * fix checks the shape before writing and normalises a non-UUID identity to
 * `user_id: null` (logged once), leaving a UUID identity byte-for-byte
 * unchanged.
 *
 * Runs against the real `recordOperatorTurn` + a fake PostgREST that mirrors
 * the uuid typing (a non-UUID `user_id` on insert is rejected the way
 * Postgres would reject it), so a regression can't pass against a lenient
 * stand-in.
 */

jest.mock('node-fetch');
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));

import {
  isUuidShapedUserId, recordOperatorTurn, resetOperatorThreadsWarning,
} from '../src/services/operator-threads';

type Call = { method: string; path: string; body?: any };

const UUID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

function installFakeRest(state: { threads: Record<string, any>; messages: any[] }) {
  const calls: Call[] = [];
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace('https://test.supabase.co/rest/v1/', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (status: number, data?: unknown) => ({
      ok: status < 400, status,
      text: async () => (data === undefined ? '' : JSON.stringify(data)),
    });
    const id = decodeURIComponent((path.match(/id=eq\.([^&]+)/) || [])[1] || (path.match(/thread_id=eq\.([^&]+)/) || [])[1] || '');
    if (path.startsWith('operator_threads')) {
      if (method === 'GET') return json(200, state.threads[id] ? [state.threads[id]] : []);
      if (method === 'POST') {
        // Mirror the uuid column: a non-UUID, non-null user_id is a Postgres
        // 22P02 invalid_text_representation and fails the whole insert.
        if (body.user_id !== null && !isUuidShapedUserId(body.user_id)) {
          return json(400, { code: '22P02', message: `invalid input syntax for type uuid: "${body.user_id}"` });
        }
        state.threads[body.id] = { summary: null, summary_turns: 0, ...body };
        return json(201);
      }
      if (method === 'PATCH') { Object.assign(state.threads[id], body); return json(204); }
    }
    if (path.startsWith('operator_messages') && method === 'POST') {
      state.messages.push(...body);
      return json(201);
    }
    return json(500, { error: `unhandled ${method} ${path}` });
  });
  return calls;
}

describe('VTID-04189 non-UUID identity user_id', () => {
  const ORIGINAL_ENV = process.env;
  const ORIGINAL_FETCH = (global as any).fetch;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_THREADS_ENABLED: 'true', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
    resetOperatorThreadsWarning();
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); (global as any).fetch = ORIGINAL_FETCH; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('classifies only UUID-shaped strings', () => {
    expect(isUuidShapedUserId(UUID)).toBe(true);
    expect(isUuidShapedUserId(UUID.toUpperCase())).toBe(true);
    expect(isUuidShapedUserId('claude-code-agent')).toBe(false);
    expect(isUuidShapedUserId('u1')).toBe(false);
    expect(isUuidShapedUserId(`${UUID} `)).toBe(false);
    expect(isUuidShapedUserId('')).toBe(false);
    expect(isUuidShapedUserId(null)).toBe(false);
    expect(isUuidShapedUserId(undefined)).toBe(false);
  });

  // AC-1: the row lands, with user_id null, instead of a failed insert.
  it('writes the thread with user_id null for a non-UUID identity and records the turn', async () => {
    const state = { threads: {} as Record<string, any>, messages: [] as any[] };
    const calls = installFakeRest(state);
    const r = await recordOperatorTurn({
      threadId: 'thread-nonuuid',
      identity: { user_id: 'claude-code-agent', role: 'autopilot' },
      userText: 'status?',
      reply: 'All good.',
    });
    expect(r).toEqual({ recorded: true, turns: 1 });
    const insert = calls.find((c) => c.method === 'POST' && c.path === 'operator_threads');
    expect(insert?.body.user_id).toBeNull();
    expect(state.threads['thread-nonuuid']).toMatchObject({ id: 'thread-nonuuid', user_id: null, role: 'autopilot', turns: 1 });
    expect(state.messages).toHaveLength(2);
    // Normalisation is announced once, at debug/info level (console.log), not
    // as a warning and never as a thrown failure.
    const normalised = log.mock.calls.filter((c) => String(c[0]).includes('non-UUID identity'));
    expect(normalised).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('non-UUID identity'))).toHaveLength(0);
  });

  it('logs the normalisation once per process, not once per turn', async () => {
    const state = { threads: {} as Record<string, any>, messages: [] as any[] };
    installFakeRest(state);
    await recordOperatorTurn({ threadId: 't-1', identity: { user_id: 'not-a-uuid' }, userText: 'a', reply: 'b' });
    await recordOperatorTurn({ threadId: 't-2', identity: { user_id: 'also-not-a-uuid' }, userText: 'c', reply: 'd' });
    expect(log.mock.calls.filter((c) => String(c[0]).includes('non-UUID identity'))).toHaveLength(1);
  });

  // AC-2: byte-for-byte unchanged for a real UUID identity.
  it('writes a UUID identity exactly as before', async () => {
    const state = { threads: {} as Record<string, any>, messages: [] as any[] };
    const calls = installFakeRest(state);
    const r = await recordOperatorTurn({
      threadId: UUID,
      identity: { user_id: UUID, role: 'admin' },
      userText: 'Rebuild the executor image',
      reply: 'Dispatched.',
    });
    expect(r).toEqual({ recorded: true, turns: 1 });
    const insert = calls.find((c) => c.method === 'POST' && c.path === 'operator_threads');
    expect(insert?.body.user_id).toBe(UUID);
    expect(state.threads[UUID]).toMatchObject({ id: UUID, user_id: UUID, role: 'admin', turns: 1 });
    expect(log.mock.calls.filter((c) => String(c[0]).includes('non-UUID identity'))).toHaveLength(0);
  });

  it('still writes null for a missing identity (unchanged behaviour)', async () => {
    const state = { threads: {} as Record<string, any>, messages: [] as any[] };
    const calls = installFakeRest(state);
    const r = await recordOperatorTurn({ threadId: 'thread-anon', userText: 'hi', reply: 'hello' });
    expect(r).toEqual({ recorded: true, turns: 1 });
    expect(calls.find((c) => c.method === 'POST' && c.path === 'operator_threads')?.body.user_id).toBeNull();
    expect(log.mock.calls.filter((c) => String(c[0]).includes('non-UUID identity'))).toHaveLength(0);
  });

  it('leaves an existing row untouched on later turns regardless of identity shape', async () => {
    const state = { threads: { 'thread-x': { id: 'thread-x', user_id: null, turns: 1, summary: null, summary_turns: 0 } } as Record<string, any>, messages: [] as any[] };
    const calls = installFakeRest(state);
    const r = await recordOperatorTurn({ threadId: 'thread-x', identity: { user_id: 'still-not-a-uuid' }, userText: 'more', reply: 'ok' });
    expect(r).toEqual({ recorded: true, turns: 2 });
    expect(calls.some((c) => c.method === 'POST' && c.path === 'operator_threads')).toBe(false);
    expect(state.threads['thread-x']).toMatchObject({ user_id: null, turns: 2 });
  });
});
