/**
 * VTID-04447: the Conversation API is bound to the caller's verified identity.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

import {
  resolveConversationIdentity,
  bindConversationBodyIdentity,
  bindConversationQueryIdentity,
} from '../src/routes/conversation-identity';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T_ACTIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const identity = { user_id: ME, tenant_id: T_ACTIVE };
const never = async () => false;
const always = async () => true;

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe('resolveConversationIdentity', () => {
  it('refuses a request with no verified identity', async () => {
    const d = await resolveConversationIdentity(undefined, { user_id: ME }, always);
    expect(d).toMatchObject({ ok: false, status: 401, error: 'UNAUTHENTICATED' });
  });

  it('refuses a body user_id that is not the caller', async () => {
    const d = await resolveConversationIdentity(identity, { user_id: OTHER, tenant_id: T_ACTIVE }, always);
    expect(d).toMatchObject({ ok: false, status: 403, error: 'IDENTITY_MISMATCH' });
  });

  it('fills user and tenant from the JWT when the body omits them', async () => {
    const d = await resolveConversationIdentity(identity, {}, never);
    expect(d).toEqual({ ok: true, user_id: ME, tenant_id: T_ACTIVE });
  });

  it('accepts the caller naming themselves and their active tenant', async () => {
    const d = await resolveConversationIdentity(identity, { user_id: ME, tenant_id: T_ACTIVE }, never);
    expect(d).toEqual({ ok: true, user_id: ME, tenant_id: T_ACTIVE });
  });

  it('allows another tenant only when the caller is a member of it', async () => {
    const isMember = jest.fn(async () => true);
    const d = await resolveConversationIdentity(identity, { tenant_id: T_OTHER }, isMember);
    expect(d).toEqual({ ok: true, user_id: ME, tenant_id: T_OTHER });
    expect(isMember).toHaveBeenCalledWith(ME, T_OTHER);
  });

  it('refuses another tenant the caller is not a member of', async () => {
    const d = await resolveConversationIdentity(identity, { tenant_id: T_OTHER }, never);
    expect(d).toMatchObject({ ok: false, status: 403, error: 'TENANT_FORBIDDEN' });
  });

  it('fails closed when the membership store is unavailable', async () => {
    // the default check with no Supabase client (mocked above) must deny
    const d = await resolveConversationIdentity(identity, { tenant_id: T_OTHER });
    expect(d).toMatchObject({ ok: false, error: 'TENANT_FORBIDDEN' });
  });
});

describe('bindConversationBodyIdentity', () => {
  it('rewrites the body to the verified ids and calls next', async () => {
    const req: any = { identity, body: { channel: 'orb', message: 'hi' } };
    const res = fakeRes();
    const next = jest.fn();
    await bindConversationBodyIdentity(never)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body).toMatchObject({ channel: 'orb', message: 'hi', user_id: ME, tenant_id: T_ACTIVE });
  });

  it('stops a spoofed user_id before the handler runs', async () => {
    const req: any = { identity, body: { user_id: OTHER, tenant_id: T_ACTIVE } };
    const res = fakeRes();
    const next = jest.fn();
    await bindConversationBodyIdentity(always)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'IDENTITY_MISMATCH' });
  });
});

describe('bindConversationQueryIdentity', () => {
  it('rewrites the query to the verified ids', async () => {
    const req: any = { identity, query: {} };
    const next = jest.fn();
    await bindConversationQueryIdentity(never)(req, fakeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.query).toMatchObject({ user_id: ME, tenant_id: T_ACTIVE });
  });

  it('refuses a query naming another user', async () => {
    const req: any = { identity, query: { user_id: OTHER, tenant_id: T_ACTIVE } };
    const res = fakeRes();
    const next = jest.fn();
    await bindConversationQueryIdentity(always)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('route wiring (source contract)', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/conversation.ts'), 'utf8');
  const repo = fs.readFileSync(path.join(__dirname, '../src/routes/conversation-repository.ts'), 'utf8');

  it.each([
    [`router.post('/turn', requireAuth, bindConversationBodyIdentity(),`],
    [`router.post('/stream', requireAuth, bindConversationBodyIdentity(),`],
    [`router.get('/threads/active', requireAuth, bindConversationQueryIdentity(),`],
    [`router.get('/history/:threadId', requireAuth,`],
  ])('%s', (needle) => {
    expect(route).toContain(needle);
  });

  it('no data route is registered without requireAuth', () => {
    const regs = route.match(/router\.(get|post)\('[^']+',[^\n]*/g) || [];
    const open = regs.filter((r) => !r.includes('requireAuth'));
    // Only the static catalog / health routes stay public.
    for (const r of open) {
      expect(r).toMatch(/'\/(tool-health|tools|health)'/);
    }
  });

  it('history is filtered to the caller', () => {
    expect(route).toContain('fetchConversationHistoryQuery(supabase, threadId, limit, before, req.identity!.user_id)');
    expect(repo).toMatch(/\.eq\('thread_id', threadId\)\s*\.eq\('user_id', userId\)/);
  });
});
