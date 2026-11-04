/**
 * mt-track-s-authz / lane approvals-auth (VTID-05452).
 *
 * The three POST routes under /api/v1/approvals had no authentication, and
 * /feed/approve merged whatever branch the body named. These tests pin:
 *   - every POST route rejects a missing bearer (401) and a non-admin JWT (403);
 *   - the gateway service token and an exafy_admin JWT reach the handler;
 *   - /feed/approve answers 400 branch_mismatch when the body branch is not the
 *     PR's head branch, and merges nothing.
 *
 * VTID-05528 adds the real-path tests for the member's bearer: the SSE stream
 * and the WebSocket start bind it to the live session only when it verifies to
 * the session owner, and POST /api/v1/orb/tool passes the request bearer to the
 * tools as user_jwt. The Operator Chat service-token calls are in
 * test/operator-chat-service-token.test.ts.
 */
let identity: Record<string, unknown> | null = null;
// VTID-05528: the bind tests verify tokens and start sessions through these stubs.
const mockVerifyAndExtractIdentity = jest.fn(async (_token: string): Promise<any> => null);
const mockStartLiveSessionForWs = jest.fn(async (_input: unknown): Promise<any> => ({ status: 500, body: { ok: false } }));
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: any, _res: any, next: () => void) => {
      if (identity) req.identity = identity;
      next();
    },
    requireAuth: (req: any, _res: any, next: () => void) => {
      if (identity) req.identity = identity;
      next();
    },
    verifyAndExtractIdentity: (token: string) => mockVerifyAndExtractIdentity(token),
  };
});
jest.mock('../src/orb/live/config', () => ({
  ...jest.requireActual('../src/orb/live/config'),
  // No Vertex project in tests, so the live routes skip the upstream connect and the Google prewarm.
  VERTEX_PROJECT_ID: '',
}));
jest.mock('../src/orb/live/session/finalize-live-session', () => ({
  ...jest.requireActual('../src/orb/live/session/finalize-live-session'),
  finalizeLiveSession: jest.fn(),
}));
jest.mock('../src/orb/live/session/ws-start-adapter', () => ({
  ...jest.requireActual('../src/orb/live/session/ws-start-adapter'),
  startLiveSessionForWs: (input: unknown) => mockStartLiveSessionForWs(input),
}));
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

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import orbLiveRouter, { __executeLiveApiToolForTest, initializeOrbWebSocket } from '../src/routes/orb-live';
import orbToolRouter from '../src/routes/orb-tool';
import * as orbToolsShared from '../src/services/orb-tools-shared';
import { liveSessions } from '../src/orb/live/session/live-session-registry';

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

  it('a non-approvals tool on the generic live path gets no member bearer', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-role-test';
    // An admin session holding a bearer: the admin feedback tool must still answer "no admin session"
    // on this path, because only the approvals tools receive the bearer (VTID-05528 narrowing).
    const session = {
      sessionId: 'live-05528-scope',
      identity: { user_id: 'admin-1', tenant_id: 't-1', role: 'admin', exafy_admin: false },
      callerAccessToken: 'admin-jwt-05528',
      lang: 'en',
      inputTranscriptBuffer: '',
      turn_count: 1,
      createdAt: new Date(),
    } as unknown as Parameters<typeof __executeLiveApiToolForTest>[0];

    const out = await __executeLiveApiToolForTest(session, 'admin_list_feedback_tickets', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).toContain('signed-in admin session');
  });
});

// VTID-05528: the member's bearer is bound to a live session only when it verifies to the session owner.
// The next blocks drive the real SSE route and the real WebSocket transport. The controller, finalize and
// upstream connect are stubbed above, so nothing reaches Vertex, a database or a production host.
const OWNER = 'owner-05528';
const INTRUDER = 'intruder-05528';
const TENANT = 'tenant-05528';
const OWNER_TOKEN = 'owner-jwt-05528';
const INTRUDER_TOKEN = 'intruder-jwt-05528';
let liveSeq = 0;

function liveSessionFor(sessionId: string, ownerId: string): any {
  const session = {
    sessionId,
    active: true,
    lang: 'en',
    identity: { user_id: ownerId, tenant_id: TENANT, role: 'authenticated', exafy_admin: false, email: null, aud: null, exp: null, iat: null },
    transcriptTurns: [],
    turn_count: 0,
    createdAt: new Date(),
    lastActivity: new Date(),
  };
  liveSessions.set(sessionId, session as any);
  return session;
}

/** Verifies the two test tokens to their users; any other token does not verify. */
function verifyTestTokens(): void {
  const users: Record<string, string> = { [OWNER_TOKEN]: OWNER, [INTRUDER_TOKEN]: INTRUDER };
  mockVerifyAndExtractIdentity.mockImplementation(async (token: string) => {
    const userId = users[token];
    if (!userId) return null;
    return { identity: { user_id: userId, tenant_id: TENANT, role: 'authenticated', exafy_admin: false, email: null, aud: null, exp: null, iat: null } };
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function waitUntil(done: () => boolean, ms = 5000): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the gateway');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the SSE stream binds the member bearer only when it verifies to the session owner (VTID-05528)', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    const app = express();
    app.use('/api/v1/orb', orbLiveRouter);
    server = http.createServer(app);
    port = await listen(server);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => verifyTestTokens());

  // Resolves once the response headers arrive. The route writes the headers after its bind decision.
  function openStream(sessionId: string, token?: string): Promise<{ status: number; close: () => void }> {
    const params = token ? { session_id: sessionId, token } : { session_id: sessionId };
    const qs = new URLSearchParams(params).toString();
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/v1/orb/live/stream?${qs}`, headers: { accept: 'text/event-stream' } },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, close: () => req.destroy() });
        },
      );
      req.on('error', reject);
    });
  }

  async function boundBearer(token: string | undefined): Promise<unknown> {
    const sessionId = `live-sse-05528-${++liveSeq}`;
    const live = liveSessionFor(sessionId, OWNER);
    const stream = await openStream(sessionId, token);
    try {
      expect(stream.status).toBe(200);
      return live.callerAccessToken;
    } finally {
      stream.close();
      liveSessions.delete(sessionId);
    }
  }

  it('binds the bearer when it verifies to the session owner', async () => {
    expect(await boundBearer(OWNER_TOKEN)).toBe(OWNER_TOKEN);
  });

  it('does not bind a bearer that verifies to another user, and still serves the stream', async () => {
    expect(await boundBearer(INTRUDER_TOKEN)).toBeFalsy();
  });

  it('does not bind a token that does not verify', async () => {
    expect(await boundBearer('forged-jwt-05528')).toBeFalsy();
  });

  it('does not bind when no token is sent', async () => {
    expect(await boundBearer(undefined)).toBeFalsy();
  });
});

describe('the WebSocket start frame binds the member bearer only when it verifies to the session owner (VTID-05528)', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer();
    initializeOrbWebSocket(server);
    port = await listen(server);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    verifyTestTokens();
    // The controller starts the live session. Here it hands back a session owned by OWNER, whatever socket asks.
    mockStartLiveSessionForWs.mockImplementation(async () => {
      const sessionId = `live-ws-05528-${++liveSeq}`;
      liveSessionFor(sessionId, OWNER);
      return { status: 200, body: { ok: true, session_id: sessionId } };
    });
  });

  async function boundBearer(token: string | undefined): Promise<unknown> {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/orb/live/ws${qs}`);
    const frames: Array<Record<string, any>> = [];
    client.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    try {
      await waitUntil(() => frames.some((f) => f.type === 'connected'));
      client.send(JSON.stringify({ type: 'start', lang: 'en' }));
      await waitUntil(() => frames.some((f) => f.type === 'session_started' || f.type === 'error'));
      const started = frames.find((f) => f.type === 'session_started');
      if (!started) throw new Error(`the start frame was refused: ${JSON.stringify(frames)}`);
      const live = liveSessions.get(started.session_id);
      liveSessions.delete(started.session_id);
      return live?.callerAccessToken;
    } finally {
      client.close();
    }
  }

  it('binds the socket bearer when it verifies to the session owner', async () => {
    expect(await boundBearer(OWNER_TOKEN)).toBe(OWNER_TOKEN);
  });

  it('does not bind a bearer that verifies to another user', async () => {
    expect(await boundBearer(INTRUDER_TOKEN)).toBeFalsy();
  });

  it('does not bind a token that does not verify', async () => {
    expect(await boundBearer('forged-jwt-05528')).toBeFalsy();
  });

  it('does not bind when the socket sends no token', async () => {
    expect(await boundBearer(undefined)).toBeFalsy();
  });
});

describe('POST /api/v1/orb/tool hands the request bearer to the tools as user_jwt (VTID-05528)', () => {
  const toolApp = express();
  toolApp.use(express.json());
  toolApp.use('/api/v1', orbToolRouter);
  let dispatch: jest.SpyInstance;

  beforeEach(() => {
    identity = { user_id: 'dev-05528', tenant_id: null, role: 'developer', vitana_id: null };
    dispatch = jest.spyOn(orbToolsShared, 'dispatchOrbTool').mockResolvedValue({ ok: true, result: {} } as any);
  });
  afterEach(() => {
    dispatch.mockRestore();
  });

  it('the request bearer becomes user_jwt in the tool identity', async () => {
    await request(toolApp)
      .post('/api/v1/orb/tool')
      .set('Authorization', 'Bearer member-jwt-05528')
      .send({ name: 'dev_approve_pr', args: { approval_id: 'appr_VTID-01234_abc', confirm: true } })
      .expect(200);
    expect(dispatch.mock.calls[0][2]).toMatchObject({ user_id: 'dev-05528', user_jwt: 'member-jwt-05528' });
  });

  it('a request without a bearer gives the tool no user_jwt, so it cannot act as the caller', async () => {
    await request(toolApp).post('/api/v1/orb/tool').send({ name: 'dev_approve_pr', args: {} }).expect(200);
    expect(dispatch.mock.calls[0][2].user_jwt).toBeNull();
  });
});

describe('the bind guards and the tool bearer, as written in source (VTID-05528)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('the SSE stream binds a token only when it verified to the session owner', () => {
    expect(read('src/routes/orb-live.ts')).toContain(
      'if (token && verifiedTokenUserId && verifiedTokenUserId === session.identity?.user_id) {\n    session.callerAccessToken = token;\n  }',
    );
  });

  it('the WebSocket start binds the socket token only when its identity is the session owner', () => {
    expect(read('src/routes/orb-live.ts')).toContain(
      'if (clientSession.authToken && identity?.user_id && identity.user_id === liveSession.identity?.user_id) {\n    liveSession.callerAccessToken = clientSession.authToken;\n  }',
    );
  });

  it('orb-tool takes user_jwt from the request bearer', () => {
    expect(read('src/routes/orb-tool.ts')).toContain(
      String.raw`user_jwt: (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim() || null,`,
    );
  });
});
