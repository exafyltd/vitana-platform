/**
 * VTID-05174 (Health Hub Phase 0 / D5 remainder, PLAT-D5R) —
 * POST /api/v1/internal/health-erasure/member-residue.
 *
 * Every database call is mocked (the repository seam is auto-mocked); nothing
 * here reaches a real database.
 *
 * Pins:
 *   1. Auth: no token 401, member JWT 403, service token / admin JWT pass.
 *   2. Non-uuid user_id 400; staging 409 STAGING_READ_ONLY with no DB call.
 *   3. Part a: tokens wiped, revokeAtVendor once per connector; a vendor
 *      failure still gives complete:true; tokens never logged/emitted/returned.
 *   4. Part b: filter uses user_id, Terra reference_id, Vital client_user_id;
 *      provider ids are read before any delete and used per connector.
 *   5. Part c: confirmed rows deleted, proposals cleared, the id removed from
 *      both arrays; a concurrent re-add (residual re-select) → complete:false.
 *   6. OASIS payloads carry no raw_payload, token or member id.
 *   7. Mounted exactly once; claimed by the domain atlas.
 */

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, _res: any, next: () => void) => {
    const h = String(req.headers.authorization ?? '');
    if (h === 'Bearer member-jwt') req.identity = { user_id: 'm1', exafy_admin: false };
    if (h === 'Bearer admin-jwt') req.identity = { user_id: 'a1', exafy_admin: true };
    next();
  },
}));
jest.mock('../src/routes/wearables', () => ({
  revokeAtVendor: jest.fn(),
  VENDOR_REVOKE_TIMEOUT_MS: 5_000,
}));
jest.mock('../src/connectors', () => ({
  getConnector: jest.fn((id: string) => ({ id })),
}));
jest.mock('../src/routes/health-erasure-internal-repository', () => {
  const actual = jest.requireActual('../src/routes/health-erasure-internal-repository');
  const mocked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(actual)) mocked[k] = typeof v === 'function' && !/Filter$/.test(k) ? jest.fn() : v;
  return mocked;
});

import { getSupabase } from '../src/lib/supabase';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { revokeAtVendor } from '../src/routes/wearables';
import * as repo from '../src/routes/health-erasure-internal-repository';
import router, { providerIdsByConnector } from '../src/routes/health-erasure-internal';
import { domainsForRoute } from '../src/orb/developer/domain-atlas';

const mockedRepo = repo as jest.Mocked<typeof repo>;
const mockedRevoke = revokeAtVendor as jest.MockedFunction<typeof revokeAtVendor>;
const mockedEmit = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

const UID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const SERVICE = 'svc-token';
const ACCESS = 'enc:v1:ACCESS-SECRET';
const REFRESH = 'enc:v1:REFRESH-SECRET';

const CONNECTIONS = [
  { id: 'c1', connector_id: 'terra', access_token: null, refresh_token: null, provider_user_id: 'terra-123', provider_username: null },
  { id: 'c2', connector_id: 'vital', access_token: null, refresh_token: null, provider_user_id: 'vital-9', provider_username: 'oura' },
  { id: 'c3', connector_id: 'strava', access_token: ACCESS, refresh_token: REFRESH, provider_user_id: 'strava-7', provider_username: null },
];

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/internal/health-erasure', router);
  return a;
}

function post(body: unknown, auth: string | null = `Bearer ${SERVICE}`) {
  const r = request(app()).post('/api/v1/internal/health-erasure/member-residue');
  if (auth) r.set('Authorization', auth);
  return r.send(body as object);
}

const OLD_ENV = { ...process.env };
let warn: jest.SpyInstance;
let log: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV, GATEWAY_SERVICE_TOKEN: SERVICE, VITANA_ENV: 'production' };
  (getSupabase as jest.Mock).mockReturnValue({});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});

  mockedRepo.fetchMemberConnections.mockResolvedValue({ data: CONNECTIONS, error: null } as never);
  mockedRepo.wipeMemberConnectionTokens.mockResolvedValue({ error: null } as never);
  mockedRevoke.mockResolvedValue({ status: 'ok' } as never);
  mockedRepo.deleteWebhookLogByMember.mockResolvedValue({ count: 2, error: null } as never);
  mockedRepo.deleteWebhookLogByProviderIds.mockResolvedValue({ count: 1, error: null } as never);
  mockedRepo.countWebhookLogByMember.mockResolvedValue({ count: 0, error: null } as never);
  mockedRepo.countWebhookLogByProviderIds.mockResolvedValue({ count: 0, error: null } as never);
  mockedRepo.deleteConfirmedInboxRows.mockResolvedValue({ data: [{ id: 'i1' }], error: null } as never);
  mockedRepo.clearInboxProposals.mockResolvedValue({ data: [{ id: 'i2' }], error: null } as never);
  mockedRepo.fetchInboxRowsWithMemberInArrays.mockResolvedValue({
    data: [
      { id: 'i3', candidate_user_ids: [UID, OTHER], member_declined_user_ids: [] },
      { id: 'i4', candidate_user_ids: [OTHER], member_declined_user_ids: [UID] },
    ],
    error: null,
  } as never);
  mockedRepo.updateInboxArrays.mockResolvedValue({ error: null } as never);
  mockedRepo.countInboxResidual.mockResolvedValue({ count: 0, error: null } as never);
});

afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
  error.mockRestore();
});

afterAll(() => {
  process.env = OLD_ENV;
});

const ALL_REPO_FNS = [
  'fetchMemberConnections', 'wipeMemberConnectionTokens', 'deleteWebhookLogByMember', 'countWebhookLogByMember',
  'deleteWebhookLogByProviderIds', 'countWebhookLogByProviderIds', 'deleteConfirmedInboxRows', 'clearInboxProposals',
  'fetchInboxRowsWithMemberInArrays', 'updateInboxArrays', 'countInboxResidual',
] as const;

function expectNoDbCall() {
  for (const fn of ALL_REPO_FNS) expect(mockedRepo[fn]).not.toHaveBeenCalled();
  expect(getSupabase).not.toHaveBeenCalled();
}

describe('auth and input', () => {
  it('no token → 401, no DB call', async () => {
    const res = await post({ user_id: UID }, null);
    expect(res.status).toBe(401);
    expectNoDbCall();
  });

  it('member JWT → 403, no DB call', async () => {
    const res = await post({ user_id: UID }, 'Bearer member-jwt');
    expect(res.status).toBe(403);
    expectNoDbCall();
  });

  it('wrong service token → 401', async () => {
    const res = await post({ user_id: UID }, 'Bearer nope');
    expect(res.status).toBe(401);
    expectNoDbCall();
  });

  it('service token and admin JWT pass', async () => {
    expect((await post({ user_id: UID })).status).toBe(200);
    expect((await post({ user_id: UID }, 'Bearer admin-jwt')).status).toBe(200);
  });

  it.each([[{}], [{ user_id: 'abc' }], [{ user_id: 42 }], [{ user_id: `${UID},user_id.neq.x` }]])('non-uuid body %j → 400', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_USER_ID');
    expectNoDbCall();
  });

  it('staging → 409 STAGING_READ_ONLY with no DB call', async () => {
    process.env.VITANA_ENV = 'staging';
    const res = await post({ user_id: UID });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'STAGING_READ_ONLY' });
    expectNoDbCall();
    expect(mockedRevoke).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('no database client → 503 DB_UNAVAILABLE', async () => {
    (getSupabase as jest.Mock).mockReturnValue(null);
    const res = await post({ user_id: UID });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });
});

describe('happy path', () => {
  it('answers 200 with every part and complete:true', async () => {
    const res = await post({ user_id: UID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      vendor_revoke: [
        { connector_id: 'terra', status: 'ok' },
        { connector_id: 'vital', status: 'ok' },
        { connector_id: 'strava', status: 'ok' },
      ],
      tokens_wiped: true,
      webhook_log: { deleted: 4, residual: 0 },
      partner_inbox: { deleted: 1, scrubbed: 3, residual: 0 },
      complete: true,
    });
  });

  it('idempotent: a retry that finds nothing reports zeros and complete:true', async () => {
    mockedRepo.fetchMemberConnections.mockResolvedValue({ data: [], error: null } as never);
    mockedRepo.deleteWebhookLogByMember.mockResolvedValue({ count: 0, error: null } as never);
    mockedRepo.deleteConfirmedInboxRows.mockResolvedValue({ data: [], error: null } as never);
    mockedRepo.clearInboxProposals.mockResolvedValue({ data: [], error: null } as never);
    mockedRepo.fetchInboxRowsWithMemberInArrays.mockResolvedValue({ data: [], error: null } as never);
    const res = await post({ user_id: UID });
    expect(res.body).toEqual({
      ok: true,
      vendor_revoke: [],
      tokens_wiped: true,
      webhook_log: { deleted: 0, residual: 0 },
      partner_inbox: { deleted: 0, scrubbed: 0, residual: 0 },
      complete: true,
    });
    expect(mockedRevoke).not.toHaveBeenCalled();
    expect(mockedRepo.wipeMemberConnectionTokens).not.toHaveBeenCalled();
  });
});

describe('part a — vendor revoke', () => {
  it('wipes the tokens, then calls revokeAtVendor once per connector with that connector\'s rows', async () => {
    await post({ user_id: UID });
    expect(mockedRepo.wipeMemberConnectionTokens).toHaveBeenCalledWith(expect.anything(), UID);
    expect(mockedRevoke).toHaveBeenCalledTimes(3);
    const byConnector = mockedRevoke.mock.calls.map((c) => [(c[0] as { id: string }).id, (c[1] as Array<{ id: string }>).map((r) => r.id)]);
    expect(byConnector).toEqual([['terra', ['c1']], ['vital', ['c2']], ['strava', ['c3']]]);
    for (const c of mockedRevoke.mock.calls) expect(c[2]).toBeLessThanOrEqual(5_000);
    const wipeOrder = mockedRepo.wipeMemberConnectionTokens.mock.invocationCallOrder[0];
    expect(wipeOrder).toBeLessThan(mockedRevoke.mock.invocationCallOrder[0]);
  });

  it('a vendor failure (or throw) is reported and still gives complete:true', async () => {
    mockedRevoke
      .mockResolvedValueOnce({ status: 'failed', detail: 'timeout' } as never)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'unsupported' } as never);
    const res = await post({ user_id: UID });
    expect(res.status).toBe(200);
    expect(res.body.vendor_revoke).toEqual([
      { connector_id: 'terra', status: 'failed' },
      { connector_id: 'vital', status: 'failed' },
      { connector_id: 'strava', status: 'unsupported' },
    ]);
    expect(res.body.complete).toBe(true);
  });

  it('respects the 20 s total cap: connectors past the deadline are skipped', async () => {
    const realNow = Date.now;
    let t = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    mockedRevoke.mockImplementation((async () => {
      t += 25_000;
      return { status: 'ok' };
    }) as never);
    const res = await post({ user_id: UID });
    (Date.now as jest.Mock).mockRestore();
    Date.now = realNow;
    expect(mockedRevoke).toHaveBeenCalledTimes(1);
    expect(res.body.vendor_revoke).toEqual([
      { connector_id: 'terra', status: 'ok' },
      { connector_id: 'vital', status: 'skipped_timeout' },
      { connector_id: 'strava', status: 'skipped_timeout' },
    ]);
    expect(res.body.complete).toBe(true);
  });

  it('a failed token wipe is reported, never blocks', async () => {
    mockedRepo.wipeMemberConnectionTokens.mockResolvedValue({ error: { message: 'secret db detail' } } as never);
    const res = await post({ user_id: UID });
    expect(res.body.tokens_wiped).toBe(false);
    expect(res.body.complete).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('secret db detail');
  });

  it('tokens never reach the response, OASIS or the console', async () => {
    const res = await post({ user_id: UID });
    const everything = JSON.stringify([
      res.body,
      mockedEmit.mock.calls,
      warn.mock.calls,
      log.mock.calls,
      error.mock.calls,
    ]);
    expect(everything).not.toContain('ACCESS-SECRET');
    expect(everything).not.toContain('REFRESH-SECRET');
    expect(everything).not.toContain('access_token');
    expect(everything).not.toContain('refresh_token');
  });
});

describe('part b — webhook log', () => {
  it('the member filter covers user_id, Terra reference_id and Vital client_user_id', () => {
    const f = repo.memberWebhookLogFilter(UID);
    expect(f).toBe(`user_id.eq.${UID},payload->user->>reference_id.eq.${UID},payload->>client_user_id.eq.${UID}`);
    expect(repo.PROVIDER_ID_PATHS).toEqual({ terra: 'payload->user->>user_id', vital: 'payload->>user_id' });
  });

  it('reads the provider ids before any delete and deletes by them per connector', async () => {
    await post({ user_id: UID });
    const readAt = mockedRepo.fetchMemberConnections.mock.invocationCallOrder[0];
    expect(readAt).toBeLessThan(mockedRepo.deleteWebhookLogByMember.mock.invocationCallOrder[0]);
    expect(readAt).toBeLessThan(mockedRepo.deleteWebhookLogByProviderIds.mock.invocationCallOrder[0]);
    expect(readAt).toBeLessThan(mockedRepo.deleteConfirmedInboxRows.mock.invocationCallOrder[0]);
    expect(mockedRepo.deleteWebhookLogByMember).toHaveBeenCalledWith(expect.anything(), UID);
    expect(mockedRepo.deleteWebhookLogByProviderIds.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['terra', ['terra-123']],
      ['vital', ['vital-9']],
    ]);
    expect(mockedRepo.countWebhookLogByProviderIds.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['terra', ['terra-123']],
      ['vital', ['vital-9']],
    ]);
  });

  it('only Terra and Vital provider ids are used (other connectors have no payload id path)', () => {
    const m = providerIdsByConnector(CONNECTIONS as never);
    expect(Array.from(m.entries())).toEqual([['terra', ['terra-123']], ['vital', ['vital-9']]]);
  });

  it('residual > 0 → complete:false', async () => {
    mockedRepo.countWebhookLogByProviderIds.mockResolvedValueOnce({ count: 1, error: null } as never);
    const res = await post({ user_id: UID });
    expect(res.body.webhook_log.residual).toBe(1);
    expect(res.body.complete).toBe(false);
  });

  it('a delete error → residual null, an error code (never the DB message), complete:false', async () => {
    mockedRepo.deleteWebhookLogByMember.mockResolvedValue({ count: null, error: { message: 'relation leaked detail' } } as never);
    const res = await post({ user_id: UID });
    expect(res.body.webhook_log).toEqual({ deleted: 0, residual: null, error: 'DELETE_FAILED' });
    expect(res.body.complete).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('leaked');
  });

  it('connections read failed → user-id rows still deleted, but complete:false', async () => {
    mockedRepo.fetchMemberConnections.mockResolvedValue({ data: null, error: { message: 'x' } } as never);
    const res = await post({ user_id: UID });
    expect(mockedRepo.deleteWebhookLogByMember).toHaveBeenCalled();
    expect(mockedRepo.deleteWebhookLogByProviderIds).not.toHaveBeenCalled();
    expect(mockedRevoke).not.toHaveBeenCalled();
    expect(res.body.webhook_log.error).toBe('CONNECTIONS_READ_FAILED');
    expect(res.body.complete).toBe(false);
  });
});

describe('part c — partner inbox', () => {
  it('deletes confirmed rows, clears proposals, removes the id from both arrays', async () => {
    const res = await post({ user_id: UID });
    expect(mockedRepo.deleteConfirmedInboxRows).toHaveBeenCalledWith(expect.anything(), UID);
    expect(mockedRepo.clearInboxProposals).toHaveBeenCalledWith(expect.anything(), UID);
    expect(mockedRepo.updateInboxArrays.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['i3', { candidate_user_ids: [OTHER], member_declined_user_ids: [] }],
      ['i4', { candidate_user_ids: [OTHER], member_declined_user_ids: [] }],
    ]);
    for (const c of mockedRepo.updateInboxArrays.mock.calls) expect(JSON.stringify(c[2])).not.toContain(UID);
    expect(res.body.partner_inbox).toEqual({ deleted: 1, scrubbed: 3, residual: 0 });
  });

  it('a concurrent re-add found by the residual re-select → complete:false', async () => {
    mockedRepo.countInboxResidual.mockResolvedValue({ count: 1, error: null } as never);
    const res = await post({ user_id: UID });
    expect(res.status).toBe(200);
    expect(res.body.partner_inbox.residual).toBe(1);
    expect(res.body.complete).toBe(false);
  });

  it('an update error → error code, complete:false', async () => {
    mockedRepo.updateInboxArrays.mockResolvedValueOnce({ error: { message: 'x' } } as never);
    const res = await post({ user_id: UID });
    expect(res.body.partner_inbox.error).toBe('UPDATE_FAILED');
    expect(res.body.partner_inbox.residual).toBeNull();
    expect(res.body.complete).toBe(false);
  });

  it('the clear only touches pending_member/declined rows; confirmed rows are deleted', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'health-erasure-internal-repository.ts'), 'utf8');
    const clear = src.slice(src.indexOf('export async function clearInboxProposals'), src.indexOf('export function inboxArrayFilter'));
    expect(clear).toContain(".in('member_link_status', ['pending_member', 'declined'])");
    const del = src.slice(src.indexOf('export async function deleteConfirmedInboxRows'), src.indexOf('export async function clearInboxProposals'));
    expect(del).toContain(".eq('member_link_status', 'confirmed')");
    expect(repo.inboxArrayFilter(UID)).toBe(`candidate_user_ids.cs.{${UID}},member_declined_user_ids.cs.{${UID}}`);
  });
});

describe('OASIS', () => {
  it('emits health.erasure.vendor_revoke and health.erasure.member_residue with ids/counts only', async () => {
    await post({ user_id: UID });
    const types = mockedEmit.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['health.erasure.vendor_revoke', 'health.erasure.member_residue']);
    const vr = mockedEmit.mock.calls[0][0];
    expect(vr.vtid).toBe('VTID-05174');
    expect(vr.payload).toEqual({
      connections_read: true,
      tokens_wiped: true,
      connectors: [
        { connector_id: 'terra', status: 'ok' },
        { connector_id: 'vital', status: 'ok' },
        { connector_id: 'strava', status: 'ok' },
      ],
    });
    const mr = mockedEmit.mock.calls[1][0];
    expect(mr.payload).toMatchObject({ complete: true, webhook_log: { deleted: 4, residual: 0 }, partner_inbox: { deleted: 1, scrubbed: 3, residual: 0 } });
    const all = JSON.stringify(mockedEmit.mock.calls);
    for (const banned of ['raw_payload', 'access_token', 'refresh_token', UID, 'terra-123', 'vital-9']) {
      expect(all).not.toContain(banned);
    }
  });

  it('both event types exist in CicdEventType', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'types', 'cicd.ts'), 'utf8');
    expect(src).toContain("| 'health.erasure.vendor_revoke'");
    expect(src).toContain("| 'health.erasure.member_residue'");
  });
});

describe('mount and atlas', () => {
  it('index.ts mounts the router exactly once at /api/v1/internal/health-erasure', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(src.match(/require\('\.\/routes\/health-erasure-internal'\)/g)).toHaveLength(1);
    const mounts = src.match(/mountRouterSync\(app, '\/api\/v1\/internal\/health-erasure', healthErasureInternalRouter, \{ owner: 'health-erasure-internal' \}\)/g);
    expect(mounts).toHaveLength(1);
  });

  it('the domain atlas claims both new route files', () => {
    expect(domainsForRoute('health-erasure-internal.ts').map((d) => d.key)).toContain('health');
    expect(domainsForRoute('health-erasure-internal-repository.ts').length).toBeGreaterThan(0);
  });
});
