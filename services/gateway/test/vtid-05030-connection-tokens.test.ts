/**
 * VTID-05030 — Health Hub WP2 / D1: wearable connection tokens.
 *
 * Pins:
 *   1. seal/open: AES-256-GCM packed as enc:v1:<base64(iv‖tag‖ct)>; anything
 *      not sealed, tampered or truncated opens to null; no key → no seal.
 *   2. OAuth callback: stores only sealed tokens, refuses to store anything
 *      without the key, and never puts an exception message in the redirect.
 *   3. Disconnect: wipes the stored tokens first, then revokes at the vendor
 *      with the opened token, bounded; a vendor failure or hang never blocks.
 *   4. Vendor auth.revoked webhook wipes the stored tokens.
 *   5. Vendor revoke request shapes (Terra, Vital, Strava, Fitbit; Oura has no
 *      documented endpoint → unsupported).
 *   6. The grants migration removes all anon/authenticated access and grants
 *      nothing back; no source writes a raw token into user_connections.
 */

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

const KEY = 'a'.repeat(64);

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/lib/oauth-state', () => ({
  signOAuthState: jest.fn(() => 'signed'),
  verifyOAuthState: jest.fn(() => ({ u: 'user-1', t: 'tenant-1', c: 'fakefit' })),
}));
jest.mock('../src/routes/wearables-repository');

const fakeConnector = {
  id: 'fakefit',
  category: 'wearable',
  display_name: 'FakeFit',
  auth_type: 'oauth2',
  capabilities: ['sleep.read'],
  exchangeCode: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('../src/connectors', () => ({
  getConnector: jest.fn((id: string) => (id === 'fakefit' ? fakeConnector : undefined)),
  listConnectors: jest.fn(() => []),
}));

import * as repo from '../src/routes/wearables-repository';
import wearablesRouter, { revokeAtVendor } from '../src/routes/wearables';
import { openToken, sealToken, SEALED_TOKEN_PREFIX } from '../src/lib/connection-token-crypto';
import terra from '../src/connectors/wearable/terra';
import vital from '../src/connectors/wearable/vital';
import strava from '../src/connectors/wearable/strava';
import fitbit from '../src/connectors/wearable/fitbit';
import oura from '../src/connectors/wearable/oura';

const mockedRepo = repo as jest.Mocked<typeof repo>;

function app() {
  const a = express();
  a.use('/api/v1/wearables', wearablesRouter);
  return a;
}

function bearer(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `Bearer ${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub })}.sig`;
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV, AI_CREDENTIALS_ENC_KEY: KEY, FRONTEND_PUBLIC_URL: 'https://app.test' };
  mockedRepo.upsertOAuthConnection.mockResolvedValue({ error: null } as never);
  mockedRepo.disconnectUserConnection.mockResolvedValue({ error: null } as never);
  mockedRepo.fetchConnectionsForDisconnect.mockResolvedValue({ data: [], error: null } as never);
});
afterAll(() => {
  process.env = OLD_ENV;
});

// ---------------------------------------------------------------------------
// 1. seal / open
// ---------------------------------------------------------------------------

describe('connection-token-crypto (VTID-05030)', () => {
  it('round-trips and never stores the plaintext', () => {
    const sealed = sealToken('ya29.secret-token')!;
    expect(sealed.startsWith(SEALED_TOKEN_PREFIX)).toBe(true);
    expect(sealed).not.toContain('ya29');
    expect(openToken(sealed)).toBe('ya29.secret-token');
  });

  it('uses a fresh IV each time', () => {
    expect(sealToken('same')).not.toBe(sealToken('same'));
  });

  it.each([
    ['iv', 0],
    ['tag', 12],
    ['ciphertext', 28],
  ])('a tampered %s byte opens to null', (_part, offset) => {
    const sealed = sealToken('token-value')!;
    const buf = Buffer.from(sealed.slice(SEALED_TOKEN_PREFIX.length), 'base64');
    buf[offset as number] ^= 0xff;
    expect(openToken(SEALED_TOKEN_PREFIX + buf.toString('base64'))).toBeNull();
  });

  it('a truncated payload, a wrong prefix, plaintext and null open to null', () => {
    expect(openToken(SEALED_TOKEN_PREFIX + Buffer.alloc(28).toString('base64'))).toBeNull();
    expect(openToken('enc:v2:' + Buffer.alloc(40).toString('base64'))).toBeNull();
    expect(openToken('ya29.plaintext')).toBeNull();
    expect(openToken(null)).toBeNull();
  });

  it('a value sealed under another key opens to null', () => {
    const sealed = sealToken('token-value')!;
    process.env.AI_CREDENTIALS_ENC_KEY = 'b'.repeat(64);
    expect(openToken(sealed)).toBeNull();
  });

  it('seals nothing without a key', () => {
    delete process.env.AI_CREDENTIALS_ENC_KEY;
    expect(sealToken('token-value')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. OAuth callback
// ---------------------------------------------------------------------------

describe('GET /callback/:connector (VTID-05030)', () => {
  it('stores only sealed tokens', async () => {
    fakeConnector.exchangeCode.mockResolvedValue({
      tokens: { access_token: 'raw-access', refresh_token: 'raw-refresh', expires_at: null },
      provider_user_id: 'p1',
    });
    const res = await request(app()).get('/api/v1/wearables/callback/fakefit?code=c&state=s');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('wearable=success');
    const row = mockedRepo.upsertOAuthConnection.mock.calls[0][1] as Record<string, string>;
    expect(row.access_token.startsWith(SEALED_TOKEN_PREFIX)).toBe(true);
    expect(row.refresh_token.startsWith(SEALED_TOKEN_PREFIX)).toBe(true);
    expect(JSON.stringify(row)).not.toContain('raw-access');
    expect(JSON.stringify(row)).not.toContain('raw-refresh');
    expect(openToken(row.access_token)).toBe('raw-access');
  });

  it('without the key stores nothing and redirects with storage_unavailable', async () => {
    delete process.env.AI_CREDENTIALS_ENC_KEY;
    const res = await request(app()).get('/api/v1/wearables/callback/fakefit?code=c&state=s');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('reason=storage_unavailable');
    expect(fakeConnector.exchangeCode).not.toHaveBeenCalled();
    expect(mockedRepo.upsertOAuthConnection).not.toHaveBeenCalled();
  });

  it('an exchange failure redirects with a fixed code, never the exception text', async () => {
    fakeConnector.exchangeCode.mockRejectedValue(new Error('invalid_grant: code xyz-secret expired for client 123'));
    const res = await request(app()).get('/api/v1/wearables/callback/fakefit?code=c&state=s');
    expect(res.headers.location).toContain('reason=exchange_failed');
    expect(res.headers.location).not.toContain('xyz-secret');
    expect(res.headers.location).not.toContain('invalid_grant');
    expect(mockedRepo.upsertOAuthConnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Disconnect
// ---------------------------------------------------------------------------

describe('POST /disconnect/:connector (VTID-05030)', () => {
  const row = () => ({
    id: 'conn-1',
    access_token: sealToken('raw-access'),
    refresh_token: sealToken('raw-refresh'),
    provider_user_id: 'vendor-user',
    provider_username: null,
  });

  it('wipes the tokens before revoking, and revokes with the opened tokens', async () => {
    const order: string[] = [];
    mockedRepo.fetchConnectionsForDisconnect.mockResolvedValue({ data: [row()], error: null } as never);
    mockedRepo.disconnectUserConnection.mockImplementation((async () => {
      order.push('wipe');
      return { error: null };
    }) as never);
    fakeConnector.revokeAccess.mockImplementation(async () => {
      order.push('revoke');
      return { status: 'ok' };
    });
    const res = await request(app()).post('/api/v1/wearables/disconnect/fakefit').set('Authorization', bearer('user-1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, connector: 'fakefit', vendor_revoke: 'ok' });
    expect(order).toEqual(['wipe', 'revoke']);
    expect(fakeConnector.revokeAccess).toHaveBeenCalledWith({
      access_token: 'raw-access',
      refresh_token: 'raw-refresh',
      provider_user_id: 'vendor-user',
      provider_slug: null,
    });
  });

  it('a vendor failure still disconnects', async () => {
    mockedRepo.fetchConnectionsForDisconnect.mockResolvedValue({ data: [row()], error: null } as never);
    fakeConnector.revokeAccess.mockResolvedValue({ status: 'failed', http_status: 500 });
    const res = await request(app()).post('/api/v1/wearables/disconnect/fakefit').set('Authorization', bearer('user-1'));
    expect(res.status).toBe(200);
    expect(res.body.vendor_revoke).toBe('failed');
    expect(mockedRepo.disconnectUserConnection).toHaveBeenCalledWith(expect.anything(), 'user-1', 'fakefit');
  });

  it('a vendor that throws or hangs is bounded and reported as failed', async () => {
    fakeConnector.revokeAccess.mockImplementation(() => new Promise(() => {}));
    const r = await revokeAtVendor(fakeConnector as never, [row()] as never, 50);
    expect(r).toEqual({ status: 'failed', detail: 'timeout' });
    fakeConnector.revokeAccess.mockRejectedValue(new Error('boom'));
    expect((await revokeAtVendor(fakeConnector as never, [row()] as never, 50)).status).toBe('failed');
  });

  it('no row → no_token; no revoke support → unsupported', async () => {
    expect(await revokeAtVendor(fakeConnector as never, [], 50)).toEqual({ status: 'no_token' });
    expect(await revokeAtVendor({ id: 'x' } as never, [row()] as never, 50)).toEqual({ status: 'unsupported' });
  });

  it('the repository wipe clears all three token columns', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wearables-repository.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function disconnectUserConnection'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    for (const col of ['access_token: null', 'refresh_token: null', 'token_expires_at: null', 'is_active: false']) {
      expect(fn).toContain(col);
    }
  });

  it('requires a signed-in user', async () => {
    const res = await request(app()).post('/api/v1/wearables/disconnect/fakefit');
    expect(res.status).toBe(401);
    expect(mockedRepo.disconnectUserConnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. auth.revoked webhook
// ---------------------------------------------------------------------------

describe('connector webhook auth.revoked (VTID-05030)', () => {
  it('wipes the stored tokens', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'connector-webhooks.ts'), 'utf8');
    const start = src.indexOf("event.topic === 'connector.wearable.auth.revoked'");
    const block = src.slice(start, src.indexOf('});', start));
    for (const col of ['access_token: null', 'refresh_token: null', 'token_expires_at: null', 'is_active: false']) {
      expect(block).toContain(col);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Vendor revoke request shapes
// ---------------------------------------------------------------------------

describe('vendor revokeAccess request shapes (VTID-05030)', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    Object.assign(process.env, {
      TERRA_API_KEY: 'tk', TERRA_DEV_ID: 'td', VITAL_API_KEY: 'vk', VITAL_ENVIRONMENT: 'production', VITAL_REGION: 'eu',
      FITBIT_CLIENT_ID: 'fid', FITBIT_CLIENT_SECRET: 'fsec',
    });
  });
  const input = { access_token: 'at', refresh_token: 'rt', provider_user_id: 'u 1', provider_slug: 'oura' };

  it('Terra: DELETE /v2/auth/deauthenticateUser with dev-id + x-api-key; 404 counts as ok', async () => {
    expect(await terra.revokeAccess!(input)).toEqual({ status: 'ok', http_status: 200 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tryterra.co/v2/auth/deauthenticateUser?user_id=u%201');
    expect(init.method).toBe('DELETE');
    expect(init.headers['dev-id']).toBe('td');
    expect(init.headers['x-api-key']).toBe('tk');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    expect((await terra.revokeAccess!(input)).status).toBe('ok');
  });

  it('Vital: DELETE {base}/user/{id}/{provider} with x-vital-api-key, no doubled /v2', async () => {
    await vital.revokeAccess!(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.production.eu.tryvital.io/v2/user/u%201/oura');
    expect(init.method).toBe('DELETE');
    expect(init.headers['x-vital-api-key']).toBe('vk');
    expect(await vital.revokeAccess!({ ...input, provider_slug: null })).toEqual({ status: 'unsupported', detail: 'provider_unknown' });
  });

  it('Strava: POST /oauth/deauthorize with the access token', async () => {
    await strava.revokeAccess!(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.strava.com/oauth/deauthorize');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('access_token=at');
  });

  it('Fitbit: POST /oauth2/revoke with Basic client auth and the refresh token', async () => {
    await fitbit.revokeAccess!(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.fitbit.com/oauth2/revoke');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('fid:fsec').toString('base64'));
    expect(init.body).toBe('token=rt');
  });

  it('Oura: unsupported, no network call', async () => {
    expect(await oura.revokeAccess!(input)).toEqual({ status: 'unsupported', detail: 'no_vendor_endpoint' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no identifier → no_token without a network call', async () => {
    const none = { access_token: null, refresh_token: null, provider_user_id: null, provider_slug: null };
    for (const c of [terra, vital, strava, fitbit]) {
      expect((await c.revokeAccess!(none)).status).toBe('no_token');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a network error is reported, never thrown', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await strava.revokeAccess!(input)).toEqual({ status: 'failed', detail: 'TypeError' });
  });
});

// ---------------------------------------------------------------------------
// 6. Grants migration + raw-token source scan
// ---------------------------------------------------------------------------

describe('user_connections grants migration (VTID-05030)', () => {
  const file = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20261010140000_vtid_05030_user_connections_token_grants.sql');
  const sql = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('revokes everything from anon and authenticated', () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.user_connections FROM anon;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.user_connections FROM authenticated;/);
  });

  it('grants nothing back and drops the client write policies', () => {
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS user_connections_insert_own/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS user_connections_update_own/);
    expect(sql).not.toMatch(/ALTER TABLE|DROP TABLE|DELETE FROM|UPDATE public/i);
  });
});

describe('no raw token write into user_connections (VTID-05030)', () => {
  it('the OAuth callback only writes sealed values', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wearables.ts'), 'utf8');
    expect(src).not.toMatch(/access_token:\s*result\.tokens/);
    expect(src).not.toMatch(/refresh_token:\s*result\.tokens/);
    expect(src).toMatch(/access_token:\s*sealedAccess/);
    expect(src).toMatch(/refresh_token:\s*sealedRefresh/);
  });
});
