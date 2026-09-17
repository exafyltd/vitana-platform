/**
 * VTID-04028 (W4d, gap analysis §4.6): stream the Operator Console turn as
 * Server-Sent Events with a live tool-call transcript.
 *
 * Three layers, each pinned independently:
 *  (1) processWithGemini's optional `onEvent` sink — model.turn / tool.call /
 *      tool.result emitted around the real tool loop, bounded payloads, a
 *      throwing sink never breaks the turn, no sink = no emission;
 *  (2) POST /api/v1/operator/chat/stream — the same turn as /chat, framed as
 *      SSE (turn.started → transcript → reply|error → done), 400 JSON on bad
 *      input before any header, /chat itself byte-identical;
 *  (3) the Command Hub client (app.js is a plain script, so a source-text
 *      guard like vtid-03822's): streams /chat/stream, renders the live
 *      transcript, falls back to /chat only when no stream is obtainable.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { NextFunction, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// (1) service: the event sink around the tool loop
// ---------------------------------------------------------------------------

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn(), listOpenPrsBare: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ describeEcsServices: jest.fn(), ALLOWED_ECS_SERVICES: ['vitana-gateway'] }));
jest.mock('../src/services/dev-agent-memory', () => ({ recallDevMemory: jest.fn(async () => ({ ok: true, hits: [] })), writeDevMemory: jest.fn() }));
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn(), getRoutingPolicy: jest.fn() }));

import { callViaRouter } from '../src/services/llm-router';
import {
  processWithGemini,
  emitTurnEvent,
  clipForTurnEvent,
  boundTurnEventArgs,
  TURN_EVENT_EXCERPT_MAX_CHARS,
  TURN_EVENT_ARGS_MAX_CHARS,
  type OperatorTurnEvent,
} from '../src/services/gemini-operator';

const routerMock = callViaRouter as jest.Mock;

function routerScript(firstToolCalls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  let call = 0;
  routerMock.mockImplementation(async () => {
    call += 1;
    if (call === 1) return { ok: true, text: '', provider: 'deepseek', model: 'deepseek-flash', toolCalls: firstToolCalls };
    return { ok: true, text: 'final reply', provider: 'deepseek', model: 'deepseek-flash', toolCalls: [] };
  });
}

describe('VTID-04028 processWithGemini onEvent sink', () => {
  beforeEach(() => routerMock.mockReset());

  it('emits model.turn(plan) → tool.call → tool.result → model.turn(final) around a real tool round, with timings and a bounded excerpt', async () => {
    // run_code executes in an in-process vm sandbox — no network, deterministic.
    routerScript([{ name: 'run_code', arguments: { code: 'console.log(6 * 7)', description: 'six times seven' } }]);
    const events: OperatorTurnEvent[] = [];
    const res = await processWithGemini({ text: 'what is 6*7', threadId: 't-04028-a', onEvent: (e) => events.push(e) });

    expect(res.reply).toBe('final reply');
    expect(res.toolResults?.[0]?.name).toBe('run_code');
    expect(events.map((e) => e.type)).toEqual(['model.turn', 'tool.call', 'tool.result', 'model.turn']);

    const plan = events[0] as Extract<OperatorTurnEvent, { type: 'model.turn' }>;
    expect(plan.stage).toBe('plan');
    expect(plan.provider).toBe('deepseek');
    expect(plan.model).toBe('deepseek-flash');
    expect(plan.tool_calls).toBe(1);
    expect(plan.duration_ms).toBeGreaterThanOrEqual(0);

    const call = events[1] as Extract<OperatorTurnEvent, { type: 'tool.call' }>;
    expect(call).toMatchObject({ index: 0, name: 'run_code', args: { code: 'console.log(6 * 7)', description: 'six times seven' } });

    const result = events[2] as Extract<OperatorTurnEvent, { type: 'tool.result' }>;
    expect(result.index).toBe(0);
    expect(result.name).toBe('run_code');
    expect(result.ok).toBe(true);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.excerpt).toBe('string');
    expect(result.excerpt.length).toBeLessThanOrEqual(TURN_EVENT_EXCERPT_MAX_CHARS + 24);
    expect(result.excerpt).toContain('42');

    const fin = events[3] as Extract<OperatorTurnEvent, { type: 'model.turn' }>;
    expect(fin.stage).toBe('final');
    expect(fin.tool_calls).toBe(0);
  });

  it('reports a failing tool honestly (ok:false + clipped error) and still finishes the turn', async () => {
    routerScript([{ name: 'no_such_tool_04028', arguments: {} }]);
    const events: OperatorTurnEvent[] = [];
    const res = await processWithGemini({ text: 'x', threadId: 't-04028-b', onEvent: (e) => events.push(e) });
    expect(res.reply).toBe('final reply');
    const result = events.find((e) => e.type === 'tool.result') as Extract<OperatorTurnEvent, { type: 'tool.result' }>;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('a throwing sink never breaks the turn', async () => {
    routerScript([{ name: 'run_code', arguments: { code: 'console.log(1)' } }]);
    const seen: string[] = [];
    const res = await processWithGemini({
      text: 'x',
      threadId: 't-04028-c',
      onEvent: (e) => { seen.push(e.type); throw new Error('sink boom'); },
    });
    expect(res.reply).toBe('final reply');
    expect(seen).toEqual(['model.turn', 'tool.call', 'tool.result', 'model.turn']);
  });

  it('emits only model.turn(plan) when the model calls no tool, and nothing at all without a sink', async () => {
    routerMock.mockResolvedValue({ ok: true, text: 'direct', provider: 'bedrock', model: 'm', toolCalls: [] });
    const events: OperatorTurnEvent[] = [];
    const res = await processWithGemini({ text: 'hi', threadId: 't-04028-d', onEvent: (e) => events.push(e) });
    expect(res.reply).toBe('direct');
    expect(events.map((e) => e.type)).toEqual(['model.turn']);

    const res2 = await processWithGemini({ text: 'hi', threadId: 't-04028-e' });
    expect(res2.reply).toBe('direct');
  });

  it('helpers: clip, bound args, swallow', () => {
    expect(clipForTurnEvent('abc', 10)).toBe('abc');
    expect(clipForTurnEvent('x'.repeat(20), 10)).toBe(`${'x'.repeat(10)}…(+10 chars)`);
    expect(clipForTurnEvent({ a: 1 }, 100)).toBe('{"a":1}');
    expect(boundTurnEventArgs({ a: 1 })).toEqual({ a: 1 });
    expect(boundTurnEventArgs(undefined)).toEqual({});
    const big = boundTurnEventArgs({ blob: 'y'.repeat(TURN_EVENT_ARGS_MAX_CHARS + 50) });
    expect(Object.keys(big)).toEqual(['_clipped']);
    expect((big._clipped as string).length).toBeLessThan(TURN_EVENT_ARGS_MAX_CHARS + 30);
    expect(() => emitTurnEvent(() => { throw new Error('x'); }, { type: 'tool.call', index: 0, name: 'n', args: {} })).not.toThrow();
    expect(() => emitTurnEvent(undefined, { type: 'tool.call', index: 0, name: 'n', args: {} })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (2) route: POST /api/v1/operator/chat/stream
// ---------------------------------------------------------------------------

let optionalAuthImpl: (req: Request, res: Response, next: NextFunction) => void = (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: Request, res: Response, next: NextFunction) => optionalAuthImpl(req, res, next),
  };
});

const createChainableMock = () => {
  const chain: any = {
    from: jest.fn(() => chain), select: jest.fn(() => chain), insert: jest.fn(() => chain), update: jest.fn(() => chain),
    delete: jest.fn(() => chain), eq: jest.fn(() => chain), order: jest.fn(() => chain), limit: jest.fn(() => chain),
    single: jest.fn(() => chain), maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve)),
  };
  return chain;
};
const mockSupabase = createChainableMock();
jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));
jest.mock('../src/services/ai-orchestrator', () => ({ processMessage: jest.fn().mockResolvedValue({ reply: 'stub', meta: {} }) }));
jest.mock('../src/services/oasis-event-service', () => ({
  default: { deployRequested: jest.fn(), deployAccepted: jest.fn(), deployFailed: jest.fn() },
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' }),
}));
jest.mock('../src/services/deploy-orchestrator', () => ({
  __esModule: true,
  default: { executeDeploy: jest.fn(), createVtid: jest.fn(), createTask: jest.fn() },
}));

// The route tests drive processWithGemini through a controllable double so
// they pin the framing, not the model. jest.mock above is hoisted; the
// service tests in (1) run against the real implementation by re-requiring
// the actual module through jest.requireActual.
jest.mock('../src/services/gemini-operator', () => {
  const actual = jest.requireActual('../src/services/gemini-operator');
  return { ...actual, processWithGemini: jest.fn(actual.processWithGemini) };
});

import request from 'supertest';
import app from '../src/index';

const processWithGeminiMock = processWithGemini as unknown as jest.Mock;

function parseSse(text: string): Array<{ event: string; data: any }> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      return { event, data: dataLines.length ? JSON.parse(dataLines.join('\n')) : null };
    });
}

describe('VTID-04028 POST /api/v1/operator/chat/stream', () => {
  beforeEach(() => {
    processWithGeminiMock.mockReset();
    optionalAuthImpl = (_req, _res, next) => next();
  });

  it('frames the turn: turn.started → transcript events from the sink → reply (the /chat body) → done', async () => {
    processWithGeminiMock.mockImplementation(async (input: any) => {
      input.onEvent?.({ type: 'model.turn', stage: 'plan', provider: 'deepseek', model: 'deepseek-flash', tool_calls: 1, duration_ms: 12 });
      input.onEvent?.({ type: 'tool.call', index: 0, name: 'dev_read_file', args: { path: 'CLAUDE.md' } });
      input.onEvent?.({ type: 'tool.result', index: 0, name: 'dev_read_file', ok: true, duration_ms: 34, excerpt: '{"content":"…"}' });
      return { reply: 'streamed reply', meta: { provider: 'deepseek', model: 'deepseek-flash', tool_calls: 1 }, toolResults: [{ name: 'dev_read_file', response: { ok: true } }] };
    });

    const res = await request(app)
      .post('/api/v1/operator/chat/stream')
      .send({ message: 'read CLAUDE.md', threadId: '11111111-1111-4111-8111-111111111111' })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const frames = parseSse(res.text);
    expect(frames.map((f) => f.event)).toEqual(['turn.started', 'model.turn', 'tool.call', 'tool.result', 'reply', 'done']);
    expect(frames[0].data.threadId).toBe('11111111-1111-4111-8111-111111111111');
    expect(frames[2].data).toEqual({ index: 0, name: 'dev_read_file', args: { path: 'CLAUDE.md' } });
    expect(frames[3].data).toMatchObject({ index: 0, name: 'dev_read_file', ok: true, duration_ms: 34 });

    const reply = frames[4].data;
    expect(reply.ok).toBe(true);
    expect(reply.reply).toBe('streamed reply');
    expect(reply.threadId).toBe('11111111-1111-4111-8111-111111111111');
    expect(reply.toolResults).toEqual([{ name: 'dev_read_file', response: { ok: true } }]);
    expect(frames[5].data.threadId).toBe('11111111-1111-4111-8111-111111111111');

    // The stream route passed a sink; processWithGemini saw it as a function.
    expect(typeof processWithGeminiMock.mock.calls[0][0].onEvent).toBe('function');
    expect(processWithGeminiMock.mock.calls[0][0].threadId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('answers bad input as plain 400 JSON before any SSE header', async () => {
    const res = await request(app).post('/api/v1/operator/chat/stream').send({}).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.ok).toBe(false);
    expect(processWithGeminiMock).not.toHaveBeenCalled();
  });

  it('a failing turn ends in an error frame (never a dangling stream) and still sends done', async () => {
    processWithGeminiMock.mockRejectedValue(new Error('router down'));
    const res = await request(app).post('/api/v1/operator/chat/stream').send({ message: 'x' }).expect(200);
    const frames = parseSse(res.text);
    expect(frames.map((f) => f.event)).toEqual(['turn.started', 'error', 'done']);
    expect(frames[1].data).toMatchObject({ status: 500, ok: false, details: 'router down' });
  });

  it('threads the verified admin identity into the turn exactly like /chat (userRole) and generates a threadId when none is given', async () => {
    optionalAuthImpl = (req, _res, next) => { (req as any).identity = { user_id: 'u-admin', exafy_admin: true }; next(); };
    processWithGeminiMock.mockResolvedValue({ reply: 'ok', meta: {}, toolResults: [] });
    const res = await request(app).post('/api/v1/operator/chat/stream').send({ message: 'x' }).expect(200);
    const frames = parseSse(res.text);
    expect(processWithGeminiMock.mock.calls[0][0].userRole).toBe('admin');
    const started = frames[0].data.threadId;
    expect(started).toMatch(/^[0-9a-f-]{36}$/);
    expect(frames.find((f) => f.event === 'reply')?.data.threadId).toBe(started);
  });

  it('POST /chat is unchanged: one JSON body, no sink passed', async () => {
    processWithGeminiMock.mockResolvedValue({ reply: 'plain', meta: { m: 1 }, toolResults: [] });
    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'x' }).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: true, reply: 'plain' });
    expect(processWithGeminiMock.mock.calls[0][0].onEvent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (3) client: app.js streams, renders live, falls back
// ---------------------------------------------------------------------------

const APP_JS = fs.readFileSync(path.join(__dirname, '../src/frontend/command-hub/app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '../src/frontend/command-hub/index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../src/frontend/command-hub/styles.css'), 'utf8');

function fnBody(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = APP_JS.indexOf('\n}\n', start);
  return APP_JS.slice(start, end);
}

describe('VTID-04028 Command Hub client', () => {
  it('sendChatMessage() goes through requestOperatorTurn(), which streams /chat/stream first', () => {
    expect(fnBody('sendChatMessage')).toContain('await requestOperatorTurn({');
    expect(fnBody('streamOperatorTurn')).toContain("fetch('/api/v1/operator/chat/stream'");
    expect(fnBody('streamOperatorTurn')).toContain('response.body.getReader()');
  });

  it('falls back to /chat only when no stream can be obtained (404 or no event-stream), never after a turn already ran', () => {
    const body = fnBody('requestOperatorTurn');
    expect(body).toContain('err.status === 404 || err.streamUnavailable');
    expect(body).toContain("fetch('/api/v1/operator/chat'");
    expect(body).toContain('if (!canFallback) throw err;');
  });

  it('applies tool.call / tool.result frames to the live transcript and re-renders; the renderer shows it while sending', () => {
    const apply = fnBody('applyOperatorTurnFrame');
    expect(apply).toContain("frame.event === 'tool.call'");
    expect(apply).toContain("frame.event === 'tool.result'");
    expect(apply).toContain('state.chatLiveTranscript[d.index]');
    expect(apply.match(/renderApp\(\);/g)?.length).toBeGreaterThanOrEqual(2);
    expect(APP_JS).toContain('chatLiveTranscript: [],');
    expect(APP_JS).toContain('if (state.chatSending) {\n        messages.appendChild(renderOperatorLiveTranscript());');
    expect(fnBody('renderOperatorLiveTranscript')).toContain("chat-tool-activity-line--' + (entry.status || 'running')");
  });

  it('parses SSE frames by blank line, ignores heartbeat comments, tolerates non-JSON data', () => {
    const body = fnBody('parseSseFrames');
    expect(body).toContain("buffer.split('\\n\\n')");
    expect(body).toContain("if (line.indexOf(':') === 0) return;");
    expect(body).toContain('catch (e) { data = { raw: raw }; }');
  });

  it('keeps the measured tool duration on the final activity line', () => {
    expect(fnBody('describeToolActivity')).toContain("typeof tr.duration_ms === 'number'");
    expect(fnBody('sendChatMessage')).toContain('tr.duration_ms = entry.duration_ms;');
  });

  it('bumps the cache-bust version and ships the live-transcript styles', () => {
    // VTID-04031 bumped the version again (cost badge); the pin is "at or after the W4d bump".
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260917-vtid-04028-operator-stream').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
    expect(CSS).toContain('.chat-tool-activity-line--running');
    expect(CSS).toContain('.chat-tool-activity-line--failed');
  });
});
