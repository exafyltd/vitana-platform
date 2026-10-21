/**
 * VTID-04022 (W4b): server-side Operator Console threads. Pins the pure
 * helpers (recall query shape, summary cadence, prompt, title/clip), the
 * persistence flow against a fake PostgREST (upsert thread, append
 * user/tool/assistant messages, summary rewrite on cadence via an injected
 * summariser), fail-open on a missing table / kill switch, and the wiring
 * into processWithGemini (recall query = summary + message).
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ describeEcsServices: jest.fn(), ALLOWED_ECS_SERVICES: ['vitana-gateway'], ALLOWED_ECS_TASK_FAMILIES: ['vitana-autopilot-executor'], TASKS_DEFAULT_LIMIT: 10, TASKS_MAX_LIMIT: 25, listEcsTasks: jest.fn() }));
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));

import {
  DEFAULT_SUMMARY_EVERY, SUMMARY_MAX_CHARS, RECALL_SUMMARY_MAX_CHARS,
  buildRecallQuery, buildSummaryPrompt, clipMessage, deriveThreadTitle, shouldSummarize, summaryEvery,
  isOperatorThreadsEnabled, recordOperatorTurn, getThreadSummary, maybeSummarizeThread, resetOperatorThreadsWarning,
} from '../src/services/operator-threads';

describe('VTID-04022 pure helpers', () => {
  it('buildRecallQuery returns the raw message with no summary, and summary + message otherwise (bounded)', () => {
    expect(buildRecallQuery(null, 'fix the watcher')).toBe('fix the watcher');
    expect(buildRecallQuery('   ', 'fix the watcher')).toBe('fix the watcher');
    const q = buildRecallQuery('We are on VTID-04017; PR #3388 merged.', 'now rebuild the image');
    expect(q).toBe('Conversation so far: We are on VTID-04017; PR #3388 merged.\n\nCurrent message: now rebuild the image');
    const long = buildRecallQuery('x'.repeat(RECALL_SUMMARY_MAX_CHARS + 500), 'm');
    expect(long.length).toBeLessThan(RECALL_SUMMARY_MAX_CHARS + 60);
    expect(long.endsWith('Current message: m')).toBe(true);
  });

  it('shouldSummarize fires only on the cadence and only past the last summarised turn', () => {
    expect(shouldSummarize(10, 0, 10)).toBe(true);
    expect(shouldSummarize(20, 10, 10)).toBe(true);
    expect(shouldSummarize(9, 0, 10)).toBe(false);
    expect(shouldSummarize(10, 10, 10)).toBe(false);
    expect(shouldSummarize(0, 0, 10)).toBe(false);
  });

  it('summaryEvery reads the env with a floor of 2 and the documented default', () => {
    expect(summaryEvery({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SUMMARY_EVERY);
    expect(summaryEvery({ OPERATOR_THREAD_SUMMARY_EVERY: '4' } as NodeJS.ProcessEnv)).toBe(4);
    expect(summaryEvery({ OPERATOR_THREAD_SUMMARY_EVERY: '1' } as NodeJS.ProcessEnv)).toBe(DEFAULT_SUMMARY_EVERY);
    expect(summaryEvery({ OPERATOR_THREAD_SUMMARY_EVERY: 'lots' } as NodeJS.ProcessEnv)).toBe(DEFAULT_SUMMARY_EVERY);
  });

  it('isOperatorThreadsEnabled is the exact string true', () => {
    expect(isOperatorThreadsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isOperatorThreadsEnabled({ OPERATOR_THREADS_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOperatorThreadsEnabled({ OPERATOR_THREADS_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('deriveThreadTitle takes the first non-empty line, bounded; clipMessage marks the cut', () => {
    expect(deriveThreadTitle('\n\n  Rebuild the executor image  \nmore')).toBe('Rebuild the executor image');
    expect(deriveThreadTitle('')).toBe('Operator thread');
    expect(deriveThreadTitle('a'.repeat(200)).length).toBe(80);
    expect(clipMessage('short')).toBe('short');
    expect(clipMessage('y'.repeat(50), 10)).toBe(`${'y'.repeat(10)}\n…[clipped]`);
  });

  it('buildSummaryPrompt is English model instruction carrying the prior summary and a flattened transcript', () => {
    const p = buildSummaryPrompt([
      { role: 'user', content: 'run test 6\non staging' },
      { role: 'tool', tool_name: 'autopilot_run_task', content: '{"ok":true}' },
      { role: 'assistant', content: 'Queued.' },
    ], 'Earlier: W3 merged.');
    expect(p).toContain(`Hard limit: ${SUMMARY_MAX_CHARS} characters`);
    expect(p).toContain('Previous summary:\nEarlier: W3 merged.');
    expect(p).toContain('user: run test 6 on staging');
    expect(p).toContain('tool(autopilot_run_task): {"ok":true}');
    expect(p).toContain('assistant: Queued.');
    expect(buildSummaryPrompt([{ role: 'user', content: 'hi' }], null)).not.toContain('Previous summary');
  });
});

// ---------------------------------------------------------------------------
// Persistence against a fake PostgREST
// ---------------------------------------------------------------------------

type Call = { method: string; path: string; body?: unknown };

function installFakeRest(state: { threads: Record<string, any>; messages: any[]; missingTable?: boolean }) {
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
    if (state.missingTable) return json(404, { code: 'PGRST205', message: 'Could not find the table public.operator_threads' });
    const id = decodeURIComponent((path.match(/id=eq\.([^&]+)/) || [])[1] || (path.match(/thread_id=eq\.([^&]+)/) || [])[1] || '');
    if (path.startsWith('operator_threads')) {
      if (method === 'GET') return json(200, state.threads[id] ? [state.threads[id]] : []);
      if (method === 'POST') { state.threads[body.id] = { summary: null, summary_turns: 0, ...body }; return json(201); }
      if (method === 'PATCH') { Object.assign(state.threads[id], body); return json(204); }
    }
    if (path.startsWith('operator_messages')) {
      if (method === 'POST') {
        // VTID-04095: real PostgREST rejects a bulk-insert array whose
        // objects don't all share the exact same key set (PGRST102 "All
        // object keys must match") — mirror that here so a regression
        // can't silently pass against a too-lenient fake again.
        if (Array.isArray(body) && body.length > 1) {
          const keysets = body.map((o: any) => Object.keys(o).sort().join(','));
          if (new Set(keysets).size > 1) {
            return json(400, { code: 'PGRST102', message: 'All object keys must match' });
          }
        }
        state.messages.push(...body);
        return json(201);
      }
      if (method === 'GET') {
        const rows = state.messages.filter((m) => m.thread_id === id).map((m, i) => ({ ...m, created_at: new Date(1_758_000_000_000 + i * 1000).toISOString() }));
        return json(200, rows.slice().reverse().slice(0, 30));
      }
    }
    return json(500, { error: `unhandled ${method} ${path}` });
  });
  return calls;
}

describe('VTID-04022 recordOperatorTurn / getThreadSummary / maybeSummarizeThread', () => {
  const ORIGINAL_ENV = process.env;
  const ORIGINAL_FETCH = (global as any).fetch;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_THREADS_ENABLED: 'true', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
    resetOperatorThreadsWarning();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); (global as any).fetch = ORIGINAL_FETCH; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('is a no-op (recorded:false, turns:0) when the kill switch is off — no fetch at all', async () => {
    delete process.env.OPERATOR_THREADS_ENABLED;
    const state = { threads: {}, messages: [] };
    const calls = installFakeRest(state);
    expect(await recordOperatorTurn({ threadId: 't1', userText: 'hi', reply: 'hello' })).toEqual({ recorded: false, turns: 0 });
    expect(await getThreadSummary('t1')).toBeNull();
    expect(await maybeSummarizeThread('t1', 10)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('creates the thread on the first turn, appends user + tool + assistant messages, increments turns on the next', async () => {
    const state = { threads: {} as Record<string, any>, messages: [] as any[] };
    const calls = installFakeRest(state);
    // VTID-04189: operator_threads.user_id is a uuid column, so a UUID-shaped
    // identity is what a real write carries; anything else is normalised to
    // null before insert (see console-task-25-non-uuid-identity-threads.test.ts).
    const userId = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
    const r1 = await recordOperatorTurn({
      threadId: 'thread-A', identity: { user_id: userId, role: 'admin' }, userText: 'Rebuild the executor image\nplease',
      reply: 'Dispatched run #12.', tools: [{ name: 'dev_github_dispatch', result: '{"run":12}' }], meta: { request_id: 'r1' },
    });
    expect(r1).toEqual({ recorded: true, turns: 1 });
    expect(state.threads['thread-A']).toMatchObject({ id: 'thread-A', user_id: userId, role: 'admin', title: 'Rebuild the executor image', turns: 1 });
    expect(state.messages.map((m) => [m.role, m.tool_name || null])).toEqual([['user', null], ['tool', 'dev_github_dispatch'], ['assistant', null]]);
    expect(state.messages[0].meta).toEqual({ request_id: 'r1' });

    const r2 = await recordOperatorTurn({ threadId: 'thread-A', userText: 'and now?', reply: 'Waiting on CI.' });
    expect(r2).toEqual({ recorded: true, turns: 2 });
    expect(state.threads['thread-A'].turns).toBe(2);
    expect(calls.filter((c) => c.method === 'POST' && c.path === 'operator_threads')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('operator_threads'))).toHaveLength(1);
    expect(state.messages).toHaveLength(5);
  });

  it('fails open when the tables do not exist yet: recorded:false, one warning naming the migration, never throws', async () => {
    const state = { threads: {}, messages: [], missingTable: true };
    installFakeRest(state);
    expect(await recordOperatorTurn({ threadId: 't', userText: 'x', reply: 'y' })).toEqual({ recorded: false, turns: 0 });
    expect(await recordOperatorTurn({ threadId: 't', userText: 'x', reply: 'y' })).toEqual({ recorded: false, turns: 0 });
    expect(await getThreadSummary('t')).toBeNull();
    const migrationWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('20260917230000_vtid_04022_operator_threads.sql'));
    expect(migrationWarnings).toHaveLength(1);
  });

  it('fails open when fetch itself rejects', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await recordOperatorTurn({ threadId: 't', userText: 'x', reply: 'y' })).toEqual({ recorded: false, turns: 0 });
    expect(await maybeSummarizeThread('t', 10)).toBe(false);
  });

  it('getThreadSummary returns the stored summary and null for blank/absent', async () => {
    const state = { threads: { a: { id: 'a', turns: 3, summary: 'So far: W4b.', summary_turns: 0 }, b: { id: 'b', turns: 1, summary: '  ', summary_turns: 0 } } as Record<string, any>, messages: [] };
    installFakeRest(state);
    expect(await getThreadSummary('a')).toBe('So far: W4b.');
    expect(await getThreadSummary('b')).toBeNull();
    expect(await getThreadSummary('nope')).toBeNull();
  });

  it('maybeSummarizeThread rewrites the summary on the cadence with the injected summariser and records summary_turns', async () => {
    const state = { threads: { a: { id: 'a', turns: 10, summary: 'old', summary_turns: 0, title: 't' } } as Record<string, any>, messages: [] as any[] };
    for (let i = 0; i < 10; i++) {
      state.messages.push({ thread_id: 'a', role: 'user', content: `q${i}` }, { thread_id: 'a', role: 'assistant', content: `a${i}` });
    }
    installFakeRest(state);
    const summarize = jest.fn(async (prompt: string) => {
      expect(prompt).toContain('Previous summary:\nold');
      expect(prompt).toContain('user: q0');
      expect(prompt).toContain('assistant: a9');
      return 'New rolling summary.';
    });
    expect(await maybeSummarizeThread('a', 10, { summarize })).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(state.threads.a).toMatchObject({ summary: 'New rolling summary.', summary_turns: 10 });
    // Not on cadence → no call.
    expect(await maybeSummarizeThread('a', 11, { summarize })).toBe(false);
    // Same turn again → already summarised.
    expect(await maybeSummarizeThread('a', 10, { summarize })).toBe(false);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('maybeSummarizeThread keeps the old summary when the summariser returns nothing', async () => {
    const state = { threads: { a: { id: 'a', turns: 10, summary: 'old', summary_turns: 0 } } as Record<string, any>, messages: [{ thread_id: 'a', role: 'user', content: 'q' }] };
    installFakeRest(state);
    expect(await maybeSummarizeThread('a', 10, { summarize: async () => null })).toBe(false);
    expect(state.threads.a.summary).toBe('old');
  });

  it('the default summariser goes through the memory routing stage and clips to the limit', async () => {
    const { callViaRouter } = require('../src/services/llm-router');
    (callViaRouter as jest.Mock).mockResolvedValue({ ok: true, text: `  ${'s'.repeat(SUMMARY_MAX_CHARS + 100)}  `, provider: 'bedrock' });
    const state = { threads: { a: { id: 'a', turns: 10, summary: null, summary_turns: 0 } } as Record<string, any>, messages: [{ thread_id: 'a', role: 'user', content: 'q' }] };
    installFakeRest(state);
    expect(await maybeSummarizeThread('a', 10)).toBe(true);
    expect(callViaRouter).toHaveBeenCalledWith('memory', expect.stringContaining('rolling summary'), expect.objectContaining({ service: 'operator-threads' }));
    expect(state.threads.a.summary.length).toBe(SUMMARY_MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Wiring: processWithGemini recalls against summary + message
// ---------------------------------------------------------------------------

describe('VTID-04022 processWithGemini wiring', () => {
  it('passes buildRecallQuery(threadSummary, text) to recallDevMemory', async () => {
    jest.resetModules();
    const recall = jest.fn(async () => ({ ok: true, hits: [] }));
    jest.doMock('../src/services/dev-agent-memory', () => ({
      recallDevMemory: recall,
      writeDevMemory: jest.fn(),
    }));
    jest.doMock('../src/services/llm-router', () => ({
      callViaRouter: jest.fn(async () => ({ ok: true, text: 'reply', provider: 'deepseek', model: 'deepseek-flash', toolCalls: [] })),
      getRoutingPolicy: jest.fn(),
    }));
    const mod = require('../src/services/gemini-operator');
    await mod.processWithGemini({ text: 'now rebuild the image', threadId: 'wiring-thread', threadSummary: 'We merged W3.' });
    expect(recall).toHaveBeenCalled();
    expect(recall.mock.calls[0][0]).toBe('Conversation so far: We merged W3.\n\nCurrent message: now rebuild the image');
    expect(recall.mock.calls[0][1]).toBe('vitana-platform');
  });
});
