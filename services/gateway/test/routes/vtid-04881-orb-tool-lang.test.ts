/**
 * VTID-04881 — POST /api/v1/orb/tool takes the member's language from the
 * LiveKit agent, so the shared tools answer in it, and never a session id.
 */
process.env.NODE_ENV = 'test';

const dispatchOrbTool = jest.fn().mockResolvedValue({ ok: true, result: {} });
jest.mock('../../src/services/orb-tools-shared', () => ({ dispatchOrbTool: (...a: unknown[]) => dispatchOrbTool(...a) }));
jest.mock('../../src/routes/orb-live', () => ({ resolveEffectiveRole: jest.fn().mockResolvedValue('community') }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'u1', tenant_id: 't1', role: 'authenticated', vitana_id: 'maria' };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import router, { toolCallLang } from '../../src/routes/orb-tool';

const app = express();
app.use(express.json());
app.use('/api/v1', router);

const identitySent = () => dispatchOrbTool.mock.calls[0][2];

beforeEach(() => dispatchOrbTool.mockClear());

describe('toolCallLang', () => {
  it.each([
    ['de', 'de'],
    [' SR ', 'sr'],
    ['pt-BR', 'pt'],
    ['zh-Hans', 'zh'],
  ])('%j -> %s', (raw, want) => expect(toolCallLang({ lang: raw })).toBe(want));

  it.each([[undefined], [''], ['deutsch'], ['de_DE'], ['d'], [7], ['de; drop table']])('ignores %j', (raw) => {
    expect(toolCallLang({ lang: raw })).toBeUndefined();
  });
});

describe('POST /api/v1/orb/tool', () => {
  it('passes a valid language into the tool identity', async () => {
    await request(app).post('/api/v1/orb/tool').send({ name: 'navigate', args: { question: 'q' }, lang: 'de' }).expect(200);
    expect(identitySent()).toMatchObject({ user_id: 'u1', tenant_id: 't1', role: 'community', lang: 'de' });
  });

  it('leaves the language unset when none or an invalid one is sent (unchanged behaviour)', async () => {
    await request(app).post('/api/v1/orb/tool').send({ name: 'navigate', args: {} }).expect(200);
    await request(app).post('/api/v1/orb/tool').send({ name: 'navigate', args: {}, lang: 'not a lang' }).expect(200);
    expect(dispatchOrbTool.mock.calls[0][2].lang).toBeUndefined();
    expect(dispatchOrbTool.mock.calls[1][2].lang).toBeUndefined();
  });

  it('never takes a session id from the request (plan sparring F9)', async () => {
    await request(app)
      .post('/api/v1/orb/tool')
      .send({ name: 'navigate', args: {}, lang: 'en', session_id: 'someone-elses-session', thread_id: 'x' })
      .expect(200);
    expect(identitySent().session_id).toBeUndefined();
    expect(identitySent().thread_id).toBeUndefined();
  });

  it('identity, role and tenant still come from the JWT, not the body', async () => {
    await request(app)
      .post('/api/v1/orb/tool')
      .send({ name: 'navigate', args: {}, user_id: 'evil', tenant_id: 'evil', role: 'exafy_admin' })
      .expect(200);
    expect(identitySent()).toMatchObject({ user_id: 'u1', tenant_id: 't1', role: 'community' });
  });
});
