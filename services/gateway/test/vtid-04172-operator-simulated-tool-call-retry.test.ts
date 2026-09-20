/**
 * VTID-04172: POST /api/v1/operator/chat retries ONCE, with a strengthened
 * reminder, when the model narrates a tool call as fenced JSON instead of
 * actually invoking it — the exact failure observed live 2026-09-20 (a
 * DeepSeek turn that reasoned aloud about whether it has real
 * tool-calling, then wrote autopilot_run_task's arguments as markdown
 * instead of calling the tool).
 */

import type { NextFunction, Request, Response } from 'express';

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

jest.mock('../src/services/gemini-operator', () => {
  const actual = jest.requireActual('../src/services/gemini-operator');
  return { ...actual, processWithGemini: jest.fn() };
});

import request from 'supertest';
import app from '../src/index';
import { processWithGemini } from '../src/services/gemini-operator';

const processWithGeminiMock = processWithGemini as unknown as jest.Mock;

const SIMULATED_REPLY = [
  "I'll queue this as a governed Dev Autopilot execution.",
  '',
  '```json',
  JSON.stringify({ title: 'A real task title', request: 'Do the thing' }),
  '```',
  '',
  "Hmm, but I don't actually have a real tool execution here.",
].join('\n');

describe('VTID-04172 POST /api/v1/operator/chat — simulated tool call retry', () => {
  beforeEach(() => {
    processWithGeminiMock.mockReset();
    optionalAuthImpl = (_req, _res, next) => next();
  });

  it('retries once when the reply narrates autopilot_run_task instead of calling it, and returns the retry result', async () => {
    processWithGeminiMock
      .mockImplementationOnce(async () => ({
        reply: SIMULATED_REPLY,
        meta: { provider: 'deepseek', model: 'deepseek-flash' },
        toolResults: [{ name: 'dev_read_file', response: { ok: true } }],
      }))
      .mockImplementationOnce(async () => ({
        reply: 'Queued for real.',
        meta: { provider: 'deepseek', model: 'deepseek-flash' },
        toolResults: [{ name: 'dev_read_file', response: { ok: true } }, { name: 'autopilot_run_task', response: { ok: true, vtid: 'VTID-99998' } }],
      }));

    const res = await request(app)
      .post('/api/v1/operator/chat')
      .send({ message: 'Please queue this task' })
      .expect(200);

    expect(processWithGeminiMock).toHaveBeenCalledTimes(2);
    expect(res.body.reply).toBe('Queued for real.');
    expect(res.body.toolResults.map((t: any) => t.name)).toContain('autopilot_run_task');

    // the retry's text carries the original message plus an explicit
    // real-tool-calling reminder naming the tool it must actually invoke
    const retryArg = processWithGeminiMock.mock.calls[1][0];
    expect(retryArg.text).toContain('Please queue this task');
    expect(retryArg.text).toContain('autopilot_run_task');
    expect(retryArg.text.toLowerCase()).toContain('real function-calling');
  });

  it('does NOT retry when a real matching tool call already happened this turn', async () => {
    processWithGeminiMock.mockImplementationOnce(async () => ({
      reply: SIMULATED_REPLY,
      meta: { provider: 'deepseek', model: 'deepseek-flash' },
      toolResults: [{ name: 'autopilot_run_task', response: { ok: true, vtid: 'VTID-99997' } }],
    }));

    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'x' }).expect(200);

    expect(processWithGeminiMock).toHaveBeenCalledTimes(1);
    expect(res.body.reply).toBe(SIMULATED_REPLY);
  });

  it('does NOT retry on an ordinary reply with no simulated-call shape', async () => {
    processWithGeminiMock.mockImplementationOnce(async () => ({
      reply: 'The status of VTID-04132 is in_progress.',
      meta: { provider: 'deepseek', model: 'deepseek-flash' },
      toolResults: [],
    }));

    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'status?' }).expect(200);

    expect(processWithGeminiMock).toHaveBeenCalledTimes(1);
    expect(res.body.reply).toBe('The status of VTID-04132 is in_progress.');
  });

  it('never retries more than once, even if the retry itself is ALSO a simulated call', async () => {
    processWithGeminiMock
      .mockImplementationOnce(async () => ({ reply: SIMULATED_REPLY, meta: {}, toolResults: [] }))
      .mockImplementationOnce(async () => ({ reply: SIMULATED_REPLY, meta: {}, toolResults: [] }));

    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'x' }).expect(200);

    expect(processWithGeminiMock).toHaveBeenCalledTimes(2);
    // the second (still-simulated) reply is returned as-is — honest, not looped
    expect(res.body.reply).toBe(SIMULATED_REPLY);
  });

  it('a retry that throws falls back to the original (simulated) reply rather than 500ing', async () => {
    processWithGeminiMock
      .mockImplementationOnce(async () => ({ reply: SIMULATED_REPLY, meta: {}, toolResults: [] }))
      .mockImplementationOnce(async () => { throw new Error('router unavailable'); });

    const res = await request(app).post('/api/v1/operator/chat').send({ message: 'x' }).expect(200);

    expect(processWithGeminiMock).toHaveBeenCalledTimes(2);
    expect(res.body.reply).toBe(SIMULATED_REPLY);
  });
});
