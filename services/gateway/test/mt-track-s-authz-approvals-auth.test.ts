/**
 * mt-track-s-authz / lane approvals-auth (VTID-05452).
 *
 * The three POST routes under /api/v1/approvals had no authentication, and
 * /feed/approve merged whatever branch the body named. These tests pin:
 *   - every POST route rejects a missing bearer (401) and a non-admin JWT (403);
 *   - the gateway service token and an exafy_admin JWT reach the handler;
 *   - /feed/approve answers 400 branch_mismatch when the body branch is not the
 *     PR's head branch, and merges nothing.
 */
let identity: Record<string, unknown> | null = null;
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: any, _res: any, next: () => void) => {
      if (identity) req.identity = identity;
      next();
    },
  };
});
jest.mock('../src/services/oasis-event-service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => jest.fn(async () => ({ ok: true })) }),
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

const feedItems = [
  { pr_number: 7, branch: 'feature-x', ci_state: 'pass', mergeable: true, vtid: 'VTID-01234', title: 't', url: 'u' },
];
jest.mock('../src/services/github-service', () => ({
  __esModule: true,
  listOpenPrsWithStatus: jest.fn(async () => feedItems),
  default: {},
}));

const fetchMock = jest.fn(async (_url: string, _init?: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, result: { merged: true } }),
}));
(global as any).fetch = fetchMock;

import express from 'express';
import request from 'supertest';
import approvalsRouter from '../src/routes/approvals';

const app = express();
app.use(express.json());
app.use('/api/v1/approvals', approvalsRouter);

const ENV0 = { ...process.env };
const SVC = 'svc-token-05452';
beforeEach(() => {
  process.env = {
    ...ENV0,
    GATEWAY_SERVICE_TOKEN: SVC,
    SUPABASE_URL: 'https://example.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-role-test',
  };
  identity = null;
  fetchMock.mockClear();
});
afterAll(() => {
  process.env = ENV0;
});

const POST_ROUTES = [
  '/api/v1/approvals/feed/approve',
  '/api/v1/approvals/appr_VTID-01234_abc/approve',
  '/api/v1/approvals/appr_VTID-01234_abc/reject',
];

describe.each(POST_ROUTES)('POST %s', (url) => {
  const send = (auth?: string) => {
    const r = request(app).post(url).send({ pr_number: 7, branch: 'feature-x', reason: 'r' });
    return auth ? r.set('Authorization', auth) : r;
  };

  it('no bearer → 401 and the handler is never reached', async () => {
    const res = await send();
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-admin JWT → 403', async () => {
    identity = { user_id: 'u-1', exafy_admin: false };
    const res = await send('Bearer some-user-jwt');
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the gateway service token reaches the handler', async () => {
    const res = await send(`Bearer ${SVC}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('an exafy_admin JWT reaches the handler', async () => {
    identity = { user_id: 'admin-1', exafy_admin: true };
    const res = await send('Bearer admin-jwt');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('POST /feed/approve branch check', () => {
  it('a body branch that differs from the PR head is refused and nothing merges', async () => {
    const res = await request(app)
      .post('/api/v1/approvals/feed/approve')
      .set('Authorization', `Bearer ${SVC}`)
      .send({ pr_number: 7, branch: 'some-other-branch' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'branch_mismatch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the matching head branch proceeds to the merge call', async () => {
    const res = await request(app)
      .post('/api/v1/approvals/feed/approve')
      .set('Authorization', `Bearer ${SVC}`)
      .send({ pr_number: 7, branch: 'feature-x' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/github/autonomous-pr-merge');
  });
});

import { dev_approve_pr, dev_reject_pr } from '../src/services/orb-tools/developer-tools';

describe('developer voice tools carry the caller token (dev_approve_pr / dev_reject_pr)', () => {
  const devId = (user_jwt?: string) => ({
    user_id: 'dev-1',
    tenant_id: null,
    role: 'developer',
    ...(user_jwt ? { user_jwt } : {}),
  }) as any;
  const sb = {} as any;

  it('dev_approve_pr without a user_jwt answers the admin-session message and makes no call', async () => {
    const out = await dev_approve_pr({ approval_id: 'appr_VTID-01234_abc', confirm: true }, devId(), sb);
    expect(out.result).toMatchObject({ reason: 'no_admin_session' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dev_reject_pr without a user_jwt answers the admin-session message and makes no call', async () => {
    const out = await dev_reject_pr({ approval_id: 'appr_VTID-01234_abc', reason: 'x', confirm: true }, devId(), sb);
    expect(out.result).toMatchObject({ reason: 'no_admin_session' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dev_approve_pr with a user_jwt forwards it as the Bearer token', async () => {
    await dev_approve_pr({ approval_id: 'appr_VTID-01234_abc', confirm: true }, devId('dev-jwt-05452'), sb);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('/api/v1/approvals/appr_VTID-01234_abc/approve');
    expect(init.headers.Authorization).toBe('Bearer dev-jwt-05452');
  });

  it('dev_reject_pr with a user_jwt forwards it as the Bearer token', async () => {
    await dev_reject_pr({ approval_id: 'appr_VTID-01234_abc', reason: 'x', confirm: true }, devId('dev-jwt-05452'), sb);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('/api/v1/approvals/appr_VTID-01234_abc/reject');
    expect(init.headers.Authorization).toBe('Bearer dev-jwt-05452');
  });
});

import { __executeLiveApiToolForTest } from '../src/routes/orb-live';

describe('voice approve on the generic live path (VTID-05528)', () => {
  it('a voice session holding the member bearer approves as that member', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-role-test';
    // The WS and SSE start paths store the bearer that verified to the session owner.
    const session = {
      sessionId: 'live-05528',
      identity: { user_id: 'dev-1', tenant_id: 't-1', role: 'developer', exafy_admin: false },
      callerAccessToken: 'dev-jwt-05528',
      lang: 'en',
      inputTranscriptBuffer: '',
      turn_count: 1,
      createdAt: new Date(),
    } as unknown as Parameters<typeof __executeLiveApiToolForTest>[0];

    const out = await __executeLiveApiToolForTest(session, 'dev_approve_pr', {
      approval_id: 'appr_VTID-01234_abc',
      confirm: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('/api/v1/approvals/appr_VTID-01234_abc/approve');
    expect(init.headers.Authorization).toBe('Bearer dev-jwt-05528');
    expect(out.success).toBe(true);
    expect(out.result).not.toContain('signed-in admin session');
  });
});
